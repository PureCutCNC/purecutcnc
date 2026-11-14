// Issue #1209 P1 GPU bench runner. Bundles p1bench.ts, serves it and the data
// in work/p1 through Playwright routing (no server), and prints the median of
// 3 page loads per case. GPU=nv selects the NVIDIA GPU through PRIME offload.
//   node scripts/proto-1209/p1bench.mjs [detail] [shotDir]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const detail = Number(process.argv[2] ?? 1320)
const shotDir = process.argv[3]
const cols = detail, rows = Math.ceil(15 / (20 / detail)), cell = 20 / detail
await build({ entryPoints: ['scripts/proto-1209/p1bench.ts'], bundle: true, format: 'esm', outfile: 'work/p1/p1bench.js', logLevel: 'error' })
writeFileSync('work/p1/index.html', '<!doctype html><body style="margin:0"><script type="module" src="./p1bench.js"></script>')

// A through-cut rim cell near the bottom-centre of the stock, for the close views.
const topZ = new Float32Array(readFileSync(`work/p1/guitar-${detail}.topz.bin`).buffer.slice(0))
let best = null
for (let r = 1; r < rows - 1; r += 1) for (let c = 1; c < cols - 1; c += 1) {
  const i = r * cols + c
  if (topZ[i] > 1e-6 && topZ[i] < 0.7 && (topZ[i - 1] <= 1e-6 || topZ[i + 1] <= 1e-6)) {
    const d = Math.hypot(c * cell - 10, r * cell - 2.5)
    if (!best || d < best.d) best = { d, x: (c + 0.5) * cell, y: (r + 0.5) * cell }
  }
}

const env = process.env.GPU === 'nv'
  ? { ...process.env, __EGL_VENDOR_LIBRARY_FILENAMES: '/usr/share/glvnd/egl_vendor.d/10_nvidia.json', __NV_PRIME_RENDER_OFFLOAD: '1', __GLX_VENDOR_LIBRARY_NAME: 'nvidia' }
  : process.env
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=gl-egl', '--enable-gpu', '--ignore-gpu-blocklist'], env })
const base = `data=guitar-${detail}&cols=${cols}&rows=${rows}&cell=${cell}`
const cases = [
  ['fit dpr1', `view=fit&dpr=1`],
  ['fit dpr2', `view=fit&dpr=2`],
  ['mid dpr1', `view=mid&tx=${best.x}&tz=${best.y}&dist=0.2&dpr=1`],
  ['close top dpr1', `view=top&tx=${best.x}&tz=${best.y}&dist=0.012&dpr=1`],
]
if (shotDir) mkdirSync(shotDir, { recursive: true })
for (const [name, qs] of cases) {
  const row = []
  for (const mode of (process.env.MODES ?? 'base,a22,a33').split(',')) {
    const res = []
    for (let rep = 0; rep < 3; rep += 1) {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
      await page.route('http://bench.local/**', (route) => {
        const path = new URL(route.request().url()).pathname.slice(1)
        const type = path.endsWith('.js') ? 'text/javascript' : path.endsWith('.html') ? 'text/html' : path.endsWith('.json') ? 'application/json' : 'application/octet-stream'
        route.fulfill({ body: readFileSync(`work/p1/${path}`), contentType: type })
      })
      const errors = []
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
      await page.goto(`http://bench.local/index.html?${base}&${qs}&mode=${mode}&n=80`)
      await page.waitForFunction(() => window.__bench, null, { timeout: 300000 })
      const r = await page.evaluate(() => window.__bench)
      if (errors.length) r.consoleErrors = errors.slice(0, 2)
      if (rep === 0 && shotDir) await page.screenshot({ path: `${shotDir}/${detail}-${name.replace(/ /g, '-')}-${mode}.png` })
      res.push(r)
      await page.close()
    }
    if (res[0].error || res[0].consoleErrors) { row.push(`${mode}: ${res[0].error ?? res[0].consoleErrors.join(' | ')}`); continue }
    const med = res.map((r) => r.median).sort((a, b) => a - b)
    row.push(`${mode} ${med[1].toFixed(2)} ms`)
    if (mode === 'base') row.unshift(res[0].gpu)
  }
  console.log(`detail ${detail} | ${name} | ${row.join(' | ')}`)
}
console.log(`close-view centre: (${best.x.toFixed(3)}, ${best.y.toFixed(3)}) in`)
await browser.close()
