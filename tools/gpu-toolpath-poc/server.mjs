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

import { createServer } from 'vite'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const folder = fileURLToPath(new URL('.', import.meta.url))
const port = Number(process.env.PURECUT_GPU_POC_PORT ?? 1683)
const server = await createServer({
  root: resolve(folder, '../..'),
  server: { host: '127.0.0.1', port, strictPort: true },
  plugins: [{
    name: 'issue683-local-comparison',
    transformIndexHtml: () => [{ tag: 'script', attrs: { type: 'module', src: '/__issue683-baseline.js' }, injectTo: 'body' }],
    configureServer(vite) {
      vite.middlewares.use('/__issue683-baseline.js', async (_req, res) => {
        res.setHeader('Content-Type', 'application/javascript')
        res.end(await readFile(resolve(folder, 'client.js'), 'utf8'))
      })
    },
  }],
})
await server.listen()
console.log('Canvas reference: http://127.0.0.1:' + port + '/?toolpathRenderer=canvas')
console.log('GPU comparison: http://127.0.0.1:' + port + '/?toolpathRenderer=gpu')
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await server.close(); process.exit(0) })
