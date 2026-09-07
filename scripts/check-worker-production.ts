/**
 * Production worker startup, from the built artifact (issue #675, slice 4).
 *
 * The e2e suite runs against the Vite **dev** server, because the `__pcTest`
 * seeding seam is guarded by `import.meta.env.DEV` and is tree-shaken out of a
 * production build. That leaves a gap exactly where workers are most fragile:
 * bundling, chunk naming, and whether `new URL(..., import.meta.url)` still
 * resolves once the app is served from a hashed asset directory under a
 * non-root path.
 *
 * So this checks the built output instead, and deliberately does not rely on
 * any DEV-only hook:
 *
 *  1. `dist/` contains exactly one `toolpath.worker-*.js` chunk;
 *  2. the app boots from a **nested** static path with no console errors,
 *     which is what `base: './'` exists for and what a packaged desktop build
 *     and static hosting both do;
 *  3. a module worker constructed from that chunk completes the protocol
 *     handshake — the worker really starts, in the real bundle.
 *
 * Usage: npm run check:worker-production   (requires `vite build` to have run)
 */

import { createServer } from 'node:http'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DIST = join(ROOT, 'dist')
/** Served under a nested path on purpose: root-relative asset URLs would 404 here. */
const BASE_PATH = '/deep/nested/app'

/**
 * Requests that are expected to 404 against a locally built `dist/`, with the
 * reason. `version.json` is written by the deploy workflow, not the build, and
 * `src/utils/version.ts` already treats its absence as "unknown version" — so
 * its 404 here says the deploy step has not run, not that anything is wrong.
 *
 * Narrowly listed rather than filtered by pattern: the point of this check is
 * that nothing *else* fails to load.
 */
const EXPECTED_ABSENT = ['version.json']

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail: string): void {
  if (condition) {
    passed += 1
    console.log(`   ✓ ${name}`)
    return
  }
  failed += 1
  console.log(`   ✗ ${name}: ${detail}`)
}

async function main(): Promise<void> {
  console.log('\nProduction worker startup')

  if (!existsSync(DIST)) {
    console.error('check-worker-production: dist/ is missing — run `npx vite build` first')
    process.exit(1)
  }

  const assets = readdirSync(join(DIST, 'assets'))
  const workerChunks = assets.filter((name) => /^toolpath\.worker-.*\.js$/.test(name))
  check(
    `the build emits exactly one worker chunk (${workerChunks.join(', ') || 'none'})`,
    workerChunks.length === 1,
    `expected 1, found ${workerChunks.length}`,
  )
  if (workerChunks.length !== 1) {
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(1)
  }

  const server = createServer((request, response) => {
    const url = (request.url ?? '/').split('?')[0]
    if (!url.startsWith(BASE_PATH)) {
      response.writeHead(404).end('not found')
      return
    }
    const relative = url.slice(BASE_PATH.length) || '/'
    const target = join(DIST, normalize(relative === '/' ? '/index.html' : relative))
    if (!target.startsWith(DIST) || !existsSync(target)) {
      response.writeHead(404).end('not found')
      return
    }
    response.writeHead(200, { 'content-type': TYPES[extname(target)] ?? 'application/octet-stream' })
    response.end(readFileSync(target))
  })

  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const origin = `http://127.0.0.1:${port}${BASE_PATH}/`

  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    const consoleErrors: string[] = []
    const failedRequests: string[] = []
    const workerUrls: string[] = []
    const expected = (url: string): boolean => EXPECTED_ABSENT.some((name) => url.endsWith(name))
    page.on('console', (message) => {
      if (message.type() !== 'error') return
      // A resource-load failure names the file in `location`, not in the
      // message text ("Failed to load resource: …"), so the deploy-time file
      // has to be recognised by URL or it looks like a real error.
      const source = message.location().url
      if (expected(source) || EXPECTED_ABSENT.some((name) => message.text().includes(name))) return
      consoleErrors.push(`${message.text().slice(0, 160)}${source ? ` (${source.split('/').pop()})` : ''}`)
    })
    page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message.slice(0, 200)}`))
    page.on('requestfailed', (request) => {
      if (!expected(request.url())) failedRequests.push(`${request.url().split('/').pop()}: ${request.failure()?.errorText ?? ''}`)
    })
    page.on('response', (response) => {
      if (response.status() >= 400 && !expected(response.url())) {
        failedRequests.push(`${response.url().split('/').pop()}: HTTP ${response.status()}`)
      }
    })
    page.on('worker', (worker) => workerUrls.push(worker.url()))

    await page.goto(origin, { waitUntil: 'networkidle' })

    check(
      'the app boots from a nested static path with no console errors',
      consoleErrors.length === 0,
      consoleErrors.join(' | '),
    )
    check(
      'no asset failed to load under the nested path',
      failedRequests.length === 0,
      failedRequests.join(' | '),
    )
    check(
      'the application actually rendered',
      await page.locator('canvas').count() > 0,
      'no canvas found — the app did not mount',
    )

    // Construct the built worker exactly as the app does, and wait for the
    // handshake it posts at module scope. This is the assertion the dev-server
    // e2e cannot make: it is the production chunk that has to start.
    const handshake = await page.evaluate(async (workerFile: string) => {
      return await new Promise<{ ok: boolean; detail: string }>((resolve) => {
        let worker: Worker
        try {
          worker = new Worker(new URL(`./assets/${workerFile}`, location.href), { type: 'module' })
        } catch (error) {
          resolve({ ok: false, detail: `construction threw: ${String(error)}` })
          return
        }
        const timer = setTimeout(() => resolve({ ok: false, detail: 'no ready message within 20s' }), 20_000)
        worker.onerror = (event) => {
          clearTimeout(timer)
          resolve({ ok: false, detail: `worker error: ${(event as ErrorEvent).message ?? 'unknown'}` })
        }
        worker.onmessage = (event: MessageEvent<unknown>) => {
          const data = event.data as { kind?: string; protocolVersion?: number }
          if (data && data.kind === 'ready') {
            clearTimeout(timer)
            worker.terminate()
            resolve({ ok: true, detail: `protocol v${String(data.protocolVersion)}` })
          }
        }
      })
    }, workerChunks[0])

    check(
      `the production worker chunk starts and completes its handshake (${handshake.detail})`,
      handshake.ok,
      handshake.detail,
    )
  } finally {
    await browser.close()
    await new Promise<void>((resolve) => { server.close(() => resolve()) })
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
