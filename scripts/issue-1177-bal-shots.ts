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
 * #1177 bal-a correction 1: the handoff's Simulation screenshots, taken from the
 * real app against Frank's file.
 *
 *   npx tsx scripts/issue-1177-bal-shots.ts [project.camj] [outDir]
 *
 * Reads the file through the app's own loader, opens the Simulation tab, hides
 * the two non-rotary operations (Engrave, Cutout) so the tab replays the four
 * rotary operations, sets the Visible mode at detail 1120, and frames the
 * heightfield with the viewport's own camera:
 *
 * - both ends of the Hex flats (bar end at X 19.05, shoulder at X 31.75);
 * - one corner edge, across a facet's width.
 *
 * The camera code is the one `scripts/issue-1177-sim-app.ts` (slice sim-a) uses;
 * it is the app's own scene/camera, found through the mounted React fiber, and
 * each shot asserts the rendered camera is the requested distance away so a
 * screenshot can never silently come from the 3D preview.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium, type Page } from '@playwright/test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const projectPath = resolve(process.argv[2] ?? join(root, 'work/bolt-test-02-x-mm.camj'))
const outDir = resolve(process.argv[3] ?? join(root, 'work'))
const BAR_RADIUS = 25.4
const FLAT_RADIUS = 19.05

interface CameraPose {
  target: { x: number; y: number; z: number }
  distance: number
  /** Degrees around world Y: 0 is from +X, 90 from +Z. */
  azimuth: number
  /** Degrees above the target plane. */
  elevation: number
}

/** Framing shared with slice sim-a's `SHOULDER_VIEW`/`BAR_END_VIEW`/`EDGE_VIEW`. */
/** The chuck-side end, from the shoulder side: the flat's end wall and the bar. */
const BAR_END_VIEW: CameraPose = {
  target: { x: 20.4, y: BAR_RADIUS + FLAT_RADIUS, z: BAR_RADIUS },
  distance: 34,
  azimuth: -62,
  elevation: 26,
}
/**
 * The shoulder end: the flat's far end wall where the Hex meets the turned
 * Ø25.4, from the side the scene's light reads.
 */
const SHOULDER_VIEW: CameraPose = {
  target: { x: 30.6, y: BAR_RADIUS + FLAT_RADIUS, z: BAR_RADIUS },
  distance: 38,
  azimuth: -95,
  elevation: 24,
}
/** One corner edge of the top facet, from above and off its side. */
const EDGE_VIEW: CameraPose = {
  target: { x: 28.0, y: BAR_RADIUS + FLAT_RADIUS, z: BAR_RADIUS + 11 },
  distance: 22,
  azimuth: -20,
  elevation: 45,
}
/** The whole Hex, for the report's context. */
const OVERVIEW_VIEW: CameraPose = {
  target: { x: 25.4, y: BAR_RADIUS + FLAT_RADIUS, z: BAR_RADIUS },
  distance: 80,
  azimuth: -115,
  elevation: 38,
}

// ── dev server ──────────────────────────────────────────────────────

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolvePort(port))
    })
  })
}

async function waitForServer(url: string, timeoutMs = 90_000): Promise<void> {
  const started = Date.now()
  for (;;) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // not up yet
    }
    if (Date.now() - started > timeoutMs) throw new Error(`dev server did not answer on ${url}`)
    await new Promise((done) => setTimeout(done, 250))
  }
}

function startServer(port: number): ChildProcess {
  return spawn('npm', ['run', 'dev', '--', '--port', String(port), '--strictPort'], {
    cwd: root,
    env: { ...process.env, PURECUT_E2E_ISOLATED: '1', BROWSER: 'none' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

// ── page-side snippets (slice sim-a's) ──────────────────────────────

const DISCOVER = /* js */ `(() => {
  const container = document.getElementById('root')
  if (!container) return { ok: false, reason: 'no root' }
  const key = Object.keys(container).find((k) => k.startsWith('__reactContainer$'))
  if (!key) return { ok: false, reason: 'no React root key' }
  let found = null
  const stack = [container[key]]
  while (stack.length && !found) {
    const fiber = stack.pop()
    const local = { scene: null, camera: null, renderer: null, group: null, controller: null }
    let hook = fiber.memoizedState
    let guard = 0
    while (hook && guard < 500) {
      guard += 1
      const state = hook.memoizedState
      if (state && typeof state === 'object' && 'current' in state) {
        const current = state.current
        if (current && typeof current === 'object') {
          if (current.isScene) local.scene = current
          else if (current.isPerspectiveCamera) local.camera = current
          else if (current.domElement && typeof current.render === 'function') local.renderer = current
          else if (current.name === 'simulationStock') local.group = current
          if (current.liveGrid && typeof current.getPose === 'function') local.controller = current
        }
      }
      hook = hook.next
    }
    const owned = local.group !== null || local.controller !== null
    if (owned && local.scene && local.camera && local.renderer) found = local
    let child = fiber.child
    while (child) {
      stack.push(child)
      child = child.sibling
    }
  }
  if (!found) return { ok: false, reason: 'no simulation viewport refs yet' }
  window.__sim = found
  return { ok: true, group: Boolean(found.group), controller: Boolean(found.controller) }
})()`

const MOUNTED_GROUP = /* js */ `(() => {
  const sim = window.__sim
  let group = null
  const visit = (object) => {
    if (group) return
    if (object.name === 'simulationStock' && object.parent) { group = object; return }
    for (const child of object.children || []) visit(child)
  }
  visit(sim.scene)
  if (!group) return { ok: false, reason: 'no mounted stock group' }
  sim.group = group
  return { ok: true, children: group.children.length }
})()`

const SURFACE_UNIFORMS = /* js */ `(() => {
  const sim = window.__sim
  let surface = null
  const visit = (object) => {
    if (surface) return
    if (object.material && object.material.uniforms && object.material.uniforms.uHeightfield) { surface = object; return }
    for (const child of object.children || []) visit(child)
  }
  visit(sim.group)
  if (!surface) return { ok: false, reason: 'no heightfield surface' }
  sim.surface = surface
  return { ok: true }
})()`

const READ_VIEWPORT = /* js */ `(() => {
  const viewport = document.querySelector('#workspace-panel-simulation .simulation-viewport')
  if (!viewport) return { ready: false }
  return {
    ready: viewport.getAttribute('data-simulation-surface') === 'heightfield',
    minZ: viewport.getAttribute('data-simulation-min-z'),
    removed: viewport.getAttribute('data-simulation-removed-cells'),
    view: viewport.getAttribute('data-simulation-view'),
  }
})()`

function cameraSnippet(pose: CameraPose): string {
  return `(() => {
    const sim = window.__sim
    const pose = ${JSON.stringify(pose)}
    const azimuth = pose.azimuth * Math.PI / 180
    const elevation = pose.elevation * Math.PI / 180
    const dx = Math.cos(elevation) * Math.cos(azimuth)
    const dy = Math.sin(elevation)
    const dz = Math.cos(elevation) * Math.sin(azimuth)
    const camera = sim.camera
    camera.position.set(
      pose.target.x + dx * pose.distance,
      pose.target.y + dy * pose.distance,
      pose.target.z + dz * pose.distance,
    )
    camera.up.set(0, 1, 0)
    camera.lookAt(pose.target.x, pose.target.y, pose.target.z)
    camera.updateMatrixWorld()
    sim.renderer.render(sim.scene, camera)
    return {
      distance: camera.position.distanceTo(new (camera.position.constructor)(pose.target.x, pose.target.y, pose.target.z)),
      position: camera.position.toArray(),
    }
  })()`
}

const HIDE_TOOL = /* js */ `(() => {
  let hidden = 0
  window.__sim.scene.traverse((object) => {
    if (object.name === 'toolMesh') { object.visible = false; hidden += 1 }
  })
  return hidden
})()`

// ── app driving ─────────────────────────────────────────────────────

async function openSimulation(page: Page): Promise<void> {
  const tab = page.getByRole('tab', { name: 'Simulation' })
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click()
  await page.locator('#workspace-panel-simulation .simulation-viewport').waitFor({ state: 'visible' })
}

async function setMode(page: Page, mode: 'Selected' | 'Visible'): Promise<void> {
  await page.locator('#workspace-panel-simulation')
    .getByRole('button', { name: mode, exact: true })
    .click()
  await page.waitForTimeout(200)
}

async function hideOperation(page: Page, id: string): Promise<void> {
  await page.evaluate(`(async () => {
    const module = await import('/src/store/projectStore.ts')
    module.useProjectStore.getState().updateOperation(${JSON.stringify(id)}, { showToolpath: false })
  })()`)
}

/** Wait for the static Visible build, then for the mounted heightfield. */
async function waitForVisible(page: Page): Promise<void> {
  const overlay = page.locator('#workspace-panel-simulation .simulation-viewport__computing-overlay')
  await overlay.waitFor({ state: 'detached', timeout: 240_000 })
  await page.waitForFunction(`(() => {
    const viewport = document.querySelector('#workspace-panel-simulation .simulation-viewport')
    if (!viewport) return false
    if (viewport.getAttribute('data-simulation-surface') !== 'heightfield') return false
    if (viewport.getAttribute('data-simulation-playback-surface') !== null) return false
    const removed = Number(viewport.getAttribute('data-simulation-removed-cells') || '0')
    return removed > 0
  })()`, undefined, { timeout: 240_000 })
  await page.waitForFunction(DISCOVER, undefined, { timeout: 60_000 })
  await page.waitForFunction(MOUNTED_GROUP, undefined, { timeout: 60_000 })
  const frame = await page.evaluate(SURFACE_UNIFORMS) as { ok: boolean; reason?: string }
  if (!frame.ok) throw new Error(`heightfield not readable: ${frame.reason ?? 'unknown'}`)
}

async function screenshot(page: Page, name: string, pose: CameraPose): Promise<string> {
  await page.evaluate(HIDE_TOOL)
  const framed = await page.evaluate(cameraSnippet(pose)) as { distance: number }
  if (Math.abs(framed.distance - pose.distance) > 0.5) {
    throw new Error(`camera for ${name} is not the simulation camera: set ${pose.distance.toFixed(1)} mm, `
      + `the rendered view is ${framed.distance.toFixed(1)} mm away`)
  }
  await page.waitForTimeout(200)
  await page.evaluate(cameraSnippet(pose))
  await page.waitForTimeout(120)
  const canvasPath = join(outDir, `${name}.png`)
  await page.locator('#workspace-panel-simulation canvas').screenshot({ path: canvasPath })
  console.log(`  screenshot ${canvasPath}`)
  return canvasPath
}

function ensureWritableNodeModules(): void {
  const probe = join(root, 'node_modules/.bal-a-write-check')
  try {
    writeFileSync(probe, '')
    unlinkSync(probe)
  } catch {
    throw new Error(
      'node_modules is not writable in this worktree. Vite writes node_modules/.vite-temp, '
      + 'so a symlinked or read-only node_modules cannot run the dev server: give the worktree '
      + 'its own copy (e.g. cp -a <primary-checkout>/node_modules ./node_modules).',
    )
  }
}

async function main(): Promise<void> {
  ensureWritableNodeModules()
  mkdirSync(outDir, { recursive: true })
  const port = await freePort()
  const baseURL = `http://127.0.0.1:${port}`
  console.log(`project ${projectPath}`)
  console.log(`dev server ${baseURL}`)
  const server = startServer(port)
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null
  try {
    await waitForServer(baseURL)
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--use-mock-keychain', '--password-store=basic'],
    })
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const page = await context.newPage()
    page.setDefaultTimeout(120_000)
    const consoleErrors: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    await page.goto(baseURL)
    await page.waitForFunction(() => Boolean((window as unknown as { __pcTest?: unknown }).__pcTest))
    const json = readFileSync(projectPath, 'utf8')
    await page.evaluate(async (text: string) => {
      const seam = (window as unknown as { __pcTest: { loadProject: (json: string) => Promise<void> } }).__pcTest
      await seam.loadProject(text)
    }, json)
    await page.waitForFunction(() => Boolean(document.querySelector('.cam-operation-tree .tree-row--feature')))

    await openSimulation(page)
    await hideOperation(page, 'op0199')
    await hideOperation(page, 'op0202')
    await setMode(page, 'Visible')
    await waitForVisible(page)
    // The fine detail, so a corner edge is more than one cell wide.
    await page.locator('#workspace-panel-simulation .simulation-detail-control__slider').fill('1120')
    await waitForVisible(page)
    const viewport = await page.evaluate(READ_VIEWPORT) as { view: string; minZ: string; removed: string }
    console.log(`visible grid: view ${viewport.view}, min Z ${viewport.minZ}, removed ${viewport.removed} cells`)

    const shots = [
      await screenshot(page, 'bal-a-fix1-hex-bar-end', BAR_END_VIEW),
      await screenshot(page, 'bal-a-fix1-hex-shoulder', SHOULDER_VIEW),
      await screenshot(page, 'bal-a-fix1-hex-corner-edge', EDGE_VIEW),
      await screenshot(page, 'bal-a-fix1-hex-overview', OVERVIEW_VIEW),
    ]
    writeFileSync(join(outDir, 'bal-a-fix1-shots.json'), JSON.stringify({
      viewport, shots, consoleErrors,
    }, null, 2))
    if (consoleErrors.length > 0) console.log(`console errors:\n  ${consoleErrors.join('\n  ')}`)
  } finally {
    await browser?.close()
    server.kill('SIGTERM')
    // The dev server's own children keep the wrapper's stdio open; the shots and
    // their JSON are written by now, so end the run instead of waiting them out.
    process.exit(0)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
