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
 * Re-save every bundled example with the app itself (#1192).
 *
 * Frank's rule for the example projects is that they are converted by the
 * application, never by editing the `.camj` JSON by hand or with a script. So
 * this drives the real app in a dev server for each entry in
 * `public/examples/manifest.json`:
 *
 *   1. File → New project (the top command bar's New project action);
 *   2. the examples list in that dialog, then the example;
 *   3. wait until it has loaded and every operation has generated;
 *   4. Save it. In a browser that is `triggerDownload` (see
 *      `src/platform/browser.ts`), so Playwright's `download` event is the
 *      saved file;
 *   5. write that file over `public/examples/<file>`.
 *
 * The File System Access picker is removed from the page before it boots. The
 * script is headless, so there is no native Save dialog to answer; the app's
 * own documented fallback is the download, and that is the path exercised here.
 *
 * Usage:
 *
 *   npm run examples:resave
 *
 * The dev server is started on an isolated port so a running `npm run dev`
 * cannot be hit by accident: `PURECUT_E2E_PORT` when set (1420 is refused),
 * otherwise a free port.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium, type Page } from '@playwright/test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const examplesDir = join(root, 'public/examples')
/** The dev server's default port; a re-save must never touch it. */
const DEFAULT_DEV_PORT = 1420

interface ManifestEntry {
  id: string
  title: string
  description: string
  file: string
  thumbnail?: string
}

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

/**
 * What this run knows about the dev server it started itself, as opposed to
 * whichever process happens to answer on the port (#1192 review finding 1).
 */
export interface OwnDevServer {
  /** Why this run's server stopped, or null while it is still alive. */
  failure(): string | null
  /** Whether this run's own output announced a server on the port. */
  announcedPort(): boolean
}

/** Does `output` announce a dev server on `port`? Vite prints `Local: http://localhost:<port>/`. */
export function announcesPort(output: string, port: number): boolean {
  return new RegExp(`https?://[^\\s]*:${port}(?:[/\\s]|$)`).test(output)
}

/**
 * Wait until the dev server **this script started** answers, not merely until
 * the URL does (#1192 review finding 1).
 *
 * A port another server already holds makes `--strictPort` stop Vite, but the
 * foreign server still answers a plain HTTP probe; accepting any 200 would then
 * drive that server and write its downloads over this worktree's examples.
 * Readiness is three facts together: our process is alive, its output announced
 * the port, and the URL answers. The check runs again every poll, so a server
 * that dies after announcing is caught before the next step.
 */
export async function waitForOwnDevServer(options: {
  url: string
  port: number
  server: OwnDevServer
  timeoutMs?: number
  probe?: (url: string) => Promise<boolean>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 120_000
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)))
  const probe = options.probe ?? (async (url: string) => {
    try {
      return (await fetch(url)).ok
    } catch {
      return false
    }
  })
  const started = now()
  let answered = false
  for (;;) {
    const failure = options.server.failure()
    if (failure) throw new Error(failure)
    if (await probe(options.url)) {
      answered = true
      if (options.server.announcedPort()) return
    }
    if (now() - started > timeoutMs) {
      throw new Error(answered
        ? `${options.url} answered, but this run's dev server never announced port ${options.port}; another server may hold it`
        : `dev server did not answer on ${options.url}`)
    }
    await sleep(250)
  }
}

function startServer(port: number): ChildProcess {
  // `PURECUT_VITE_CONFIG` is for environments where the default config cannot
  // boot — a sandbox that mounts `node_modules` read-only fails Vite's config
  // temp file and dependency cache. Such a config must set `root` itself, since
  // passing `--config` moves Vite's default root to the config's directory.
  const config = process.env.PURECUT_VITE_CONFIG
  const configArgs = config ? ['--config', config] : []
  return spawn('npm', ['run', 'dev', '--', ...configArgs, '--port', String(port), '--strictPort'], {
    cwd: root,
    env: { ...process.env, PURECUT_E2E_ISOLATED: '1', BROWSER: 'none' },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group: `npm` does not forward a signal to the Vite child,
    // so a plain `server.kill()` leaves the dev server running.
    detached: true,
  })
}

/** The project name the app will show after loading `file`. */
function projectNameOf(file: string): string {
  const parsed = JSON.parse(readFileSync(join(examplesDir, file), 'utf8')) as { meta?: { name?: string } }
  const name = parsed.meta?.name
  if (!name) throw new Error(`${file} carries no meta.name`)
  return name
}

/**
 * Wait until the loaded project is the one asked for and the generation gear
 * has read "up to date" long enough that a still-stale status from the previous
 * example cannot answer for it.
 */
async function waitForLoadedAndGenerated(page: Page, name: string): Promise<void> {
  await page.waitForFunction(async (expected: string) => {
    const seam = (window as unknown as {
      __pcTest?: { getProject: () => Promise<{ meta?: { name?: string } }> }
    }).__pcTest
    if (!seam) return false
    const project = await seam.getProject()
    return project.meta?.name === expected
  }, name, { timeout: 180_000 })

  const gear = page.locator('.cam-generation-gear')
  const deadline = Date.now() + 240_000
  let readyStreak = 0
  while (Date.now() < deadline) {
    const status = await gear.getAttribute('aria-label').catch(() => null)
    if (status && /up to date/.test(status)) {
      readyStreak += 1
      if (readyStreak >= 3) return
    } else {
      readyStreak = 0
    }
    await page.waitForTimeout(250)
  }
  const lastStatus = await gear.getAttribute('aria-label').catch(() => null)
  throw new Error(`generation did not finish for ${name} (gear: ${lastStatus ?? 'missing'})`)
}

async function resaveExample(page: Page, entry: ManifestEntry): Promise<void> {
  const name = projectNameOf(entry.file)

  // File → New project. The dialog is the only route to the example list.
  await page.getByRole('button', { name: 'New project' }).click()
  const dialog = page.locator('.dialog--new-project')
  await dialog.waitFor({ state: 'visible', timeout: 30_000 })

  const card = dialog.locator('.example-project-card').filter({
    has: page.getByText(entry.title, { exact: true }),
  })
  await card.first().click()
  await dialog.waitFor({ state: 'detached', timeout: 30_000 })

  await waitForLoadedAndGenerated(page, name)
  console.log(`opened ${entry.file}; loading and generation complete`)

  // Save through the app's own action. Capture the download it triggers.
  const saveButton = page.getByRole('button', { name: /^Save project/ })
  const downloadPromise = page.waitForEvent('download', { timeout: 120_000 })
  // The click can fail on its own (an overlay, a closed page); that error is
  // the one worth reporting, so this promise must not also surface as an
  // unhandled rejection while the click is still being retried.
  downloadPromise.catch(() => {})
  await saveButton.click()
  console.log(`clicked Save on ${entry.file}`)
  const download = await downloadPromise
  const downloadedPath = await download.path()
  if (!downloadedPath) throw new Error(`no download path for ${entry.file}`)
  const content = readFileSync(downloadedPath, 'utf8')

  // Written only after a parsed file came back: a failed save must never leave
  // a truncated example behind.
  const saved = JSON.parse(content) as { version?: string; features?: unknown[]; operations?: unknown[] }
  writeFileSync(join(examplesDir, entry.file), content)
  console.log(
    `re-saved ${entry.file}: format ${saved.version ?? '(none)'}, ` +
    `${saved.features?.length ?? 0} features, ${saved.operations?.length ?? 0} operations, ` +
    `${Buffer.byteLength(content)} bytes (download ${download.suggestedFilename()})`,
  )
}

async function main(): Promise<void> {
  const requestedPort = Number(process.env.PURECUT_E2E_PORT)
  if (Number.isInteger(requestedPort) && requestedPort === DEFAULT_DEV_PORT) {
    throw new Error(`refusing to re-save against the default dev port ${DEFAULT_DEV_PORT}; set PURECUT_E2E_PORT to an isolated one`)
  }
  const port = Number.isInteger(requestedPort) && requestedPort > 0 ? requestedPort : await freePort()
  const url = `http://localhost:${port}`
  console.log(`starting dev server on ${url}`)

  const server = startServer(port)
  let serverOutput = ''
  let spawnError: string | null = null
  server.on('error', (error) => { spawnError = error.message })
  server.stdout?.on('data', (chunk: Buffer) => { serverOutput += chunk.toString() })
  server.stderr?.on('data', (chunk: Buffer) => { serverOutput += chunk.toString() })

  const manifest = JSON.parse(readFileSync(join(examplesDir, 'manifest.json'), 'utf8')) as ManifestEntry[]
  if (manifest.length === 0) throw new Error('manifest lists no examples')

  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null
  try {
    await waitForOwnDevServer({
      url,
      port,
      server: {
        failure: () => {
          if (spawnError) return `the dev server could not be started: ${spawnError}`
          if (server.exitCode === null && server.signalCode === null) return null
          const how = server.signalCode
            ? `was killed by ${server.signalCode}`
            : `exited with code ${server.exitCode}`
          return `this run's dev server ${how} before ${url} was ready; another server may already hold that port (server output above)`
        },
        announcedPort: () => announcesPort(serverOutput, port),
      },
    })
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    })
    const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 900 } })
    // No native Save dialog exists in a headless run: drop the File System
    // Access picker so the app takes its own download fallback.
    await context.addInitScript(() => {
      Object.defineProperty(window, 'showSaveFilePicker', {
        value: undefined,
        configurable: true,
        writable: true,
      })
    })
    const page = await context.newPage()
    page.on('crash', () => console.error('the app page crashed'))
    browser.on('disconnected', () => console.error('the browser disconnected'))
    // A New project over a dirty project asks to discard; the re-save has just
    // saved, so accepting is what a person clicking through would do.
    page.on('dialog', (dialog) => { void dialog.accept() })

    await page.goto(url, { waitUntil: 'load', timeout: 120_000 })
    await page.getByRole('button', { name: 'New project' }).waitFor({ state: 'visible', timeout: 120_000 })
    const picker = await page.evaluate(() => typeof (window as { showSaveFilePicker?: unknown }).showSaveFilePicker)
    if (picker !== 'undefined') throw new Error('showSaveFilePicker is still available; the save would open a native dialog')

    for (const entry of manifest) {
      await resaveExample(page, entry)
    }
  } catch (error) {
    console.error(serverOutput.slice(-4000))
    throw error
  } finally {
    await browser?.close()
    // The whole group, so Vite goes with npm (see `startServer`).
    try {
      if (server.pid !== undefined) process.kill(-server.pid, 'SIGTERM')
    } catch {
      server.kill()
    }
  }

  console.log(`re-saved ${manifest.length} example(s) in ${examplesDir}`)
}

const invokedDirectly = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
