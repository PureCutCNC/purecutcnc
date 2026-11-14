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
 * Issue #1209 P1 GPU bench. Renders one replayed grid through the shipped
 * `buildSimulationStockScene`, either unchanged (`mode=base`) or with the top
 * surface's fragment shader taking its height, cut-through and normal from the
 * analytic min over the winner moves around the fragment (`mode=a22` for the
 * 2×2 cells around it, `mode=a33` for the 3×3 around its cell; both add each
 * winner's ±1 neighbour in cut order). Frame time is a render plus a 1-pixel
 * readback, as in the #973 bench. Bundled by `p1bench.mjs`.
 */

import * as THREE from 'three'
import { buildSimulationStockScene } from '../../src/engine/simulation/simulationScene'
import type { SimulationGrid } from '../../src/engine/simulation/types'

const q = new URLSearchParams(location.search)
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d)
const MOVE_TEX_WIDTH = 4096

const ANALYTIC_HEADER = /* glsl */ `
  uniform highp usampler2D uWinner;
  uniform highp sampler2D uMoves;
  uniform vec3 uItem[8];
  uniform vec2 uOriginA;
  uniform int uMoveCount;

  vec4 moveTexel(int j) { return texelFetch(uMoves, ivec2(j % ${MOVE_TEX_WIDTH}, j / ${MOVE_TEX_WIDTH}), 0); }

  void evalMove(int m, vec2 p, float bottom, inout float h, inout vec2 g) {
    vec4 a = moveTexel(2 * m);
    vec4 b = moveTexel(2 * m + 1);
    vec3 item = uItem[int(a.w)];
    float r = item.y;
    vec2 d = b.xy - a.xy;
    float lenSq = dot(d, d);
    float t = 0.0;
    vec2 gradT = vec2(0.0);
    if (lenSq > 1e-12) {
      t = dot(p - a.xy, d) / lenSq;
      if (t > 0.0 && t < 1.0) gradT = d / lenSq;
      t = clamp(t, 0.0, 1.0);
    }
    vec2 e = p - (a.xy + d * t);
    float d2 = dot(e, e);
    if (d2 > r * r) return;
    float dz = b.z - a.z;
    float cz = lenSq > 1e-12 ? a.z + dz * t : min(a.z, b.z);
    vec2 grad = dz * gradT;
    float cut = cz;
    if (item.x == 1.0) {
      float s = sqrt(max(r * r - d2, 1e-12));
      cut = cz + r - s;
      grad += e / s;
    } else if (item.x == 2.0) {
      float dist = sqrt(d2);
      cut = cz + dist * item.z;
      grad += item.z * e / max(dist, 1e-9);
    } else if (item.x == 3.0) {
      cut = bottom;
      grad = vec2(0.0);
    }
    if (cut <= bottom) { cut = bottom; grad = vec2(0.0); }
    if (cut < h) { h = cut; g = grad; }
  }

  // The analytic height and gradient at p from the winners of the given cells
  // and each winner's neighbour on either side in cut order.
  float analyticHeight(ivec2 lo, int span, vec2 p, float top, float bottom, out vec2 g) {
    float h = top;
    g = vec2(0.0);
    int seen[9];
    int count = 0;
    ivec2 size = textureSize(uWinner, 0);
    for (int dy = 0; dy < 3; dy += 1) {
      if (dy >= span) break;
      for (int dx = 0; dx < 3; dx += 1) {
        if (dx >= span) break;
        ivec2 c = lo + ivec2(dx, dy);
        if (c.x < 0 || c.y < 0 || c.x >= size.x || c.y >= size.y) continue;
        uint w = texelFetch(uWinner, c, 0).r;
        if (w == 0xffffffffu) continue;
        int m = int(w);
        bool dup = false;
        for (int k = 0; k < 9; k += 1) { if (k >= count) break; if (seen[k] == m) dup = true; }
        if (dup) continue;
        seen[count] = m;
        count += 1;
        float item = moveTexel(2 * m).w;
        evalMove(m, p, bottom, h, g);
        if (m > 0 && moveTexel(2 * (m - 1)).w == item) evalMove(m - 1, p, bottom, h, g);
        if (m + 1 < uMoveCount && moveTexel(2 * (m + 1)).w == item) evalMove(m + 1, p, bottom, h, g);
      }
    }
    return h;
  }
`

function analyticMain(mode: string, rest: string): string {
  if (mode.endsWith('g')) {
    // Gated: analytic only where a cell spans two pixels or more; below that
    // the shipped stencil already resolves everything a pixel can show.
    const inner = analyticMain(mode.slice(0, -1), '')
    return `
    vec2 gatePos = vec2(vCell) + vLocal;
    if (max(length(dFdx(gatePos)), length(dFdy(gatePos))) < 0.5) {
${inner.replace(/\n  }\n$/, '\n    return;\n    }\n')}
${rest}`
  }
  const lo = mode === 'a22'
    ? 'ivec2(floor(cellPos - 0.5))'
    : 'vCell - ivec2(1)'
  const span = mode === 'a22' ? 2 : 3
  return /* glsl */ `
    vec2 cellPos = vec2(vCell) + vLocal;
    vec2 p = uOriginA + cellPos * uCellSize;
    vec2 g;
    float ah = analyticHeight(${lo}, ${span}, p, uStockTopZ, uStockBottomZ, g);
    if (ah <= threshold) discard;
    vec3 lighting = calcLighting(normalize(vec3(-g.x, 1.0, -g.y)));
    fragColor = vec4(uColor * lighting * depthDarken(ah, uStockTopZ), 1.0);
  }
`
}

async function run() {
  const cols = num('cols', 1320), rows = num('rows', 990)
  const cellSize = num('cell', 20 / 1320)
  const tag = q.get('data') ?? 'guitar-1320'
  const fetchBin = async (name: string) => (await (await fetch(`./${name}`)).arrayBuffer())
  const topZ = new Float32Array(await fetchBin(`${tag}.topz.bin`))
  const grid = {
    originX: 0, originY: 0, cellSize, cols, rows,
    stockBottomZ: 0, stockTopZ: num('top', 0.75), topZ,
  } as unknown as SimulationGrid
  const mode = q.get('mode') ?? 'base'
  const w = num('w', 1400), h = num('h', 900), dpr = num('dpr', 1)
  const renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setPixelRatio(dpr)
  renderer.setSize(w, h)
  document.body.appendChild(renderer.domElement)
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x151a22)
  const built = buildSimulationStockScene(grid, new THREE.Color(0xb9a83c))
  scene.add(built.group)

  let extraBytes = 0
  if (mode !== 'base') {
    const winner = new Uint32Array(await fetchBin(`${tag}.winner.bin`))
    const moves64 = new Float64Array(await fetchBin(q.get('moves') ?? 'guitar.moves.bin'))
    const meta = await (await fetch(`./${q.get('meta') ?? 'guitar.meta.json'}`)).json() as {
      items: Array<{ toolType: string; toolRadius: number; vBitAngle: number | null }>
    }
    const moveCount = moves64.length / 7
    const height = Math.ceil((2 * moveCount) / MOVE_TEX_WIDTH)
    const moves = new Float32Array(MOVE_TEX_WIDTH * height * 4)
    for (let m = 0; m < moveCount; m += 1) {
      const o = m * 7, t = m * 8
      moves[t] = moves64[o]; moves[t + 1] = moves64[o + 1]; moves[t + 2] = moves64[o + 2]; moves[t + 3] = moves64[o + 6]
      moves[t + 4] = moves64[o + 3]; moves[t + 5] = moves64[o + 4]; moves[t + 6] = moves64[o + 5]
    }
    const moveTex = new THREE.DataTexture(moves, MOVE_TEX_WIDTH, height, THREE.RGBAFormat, THREE.FloatType)
    moveTex.needsUpdate = true
    const winnerTex = new THREE.DataTexture(winner, cols, rows, THREE.RedIntegerFormat, THREE.UnsignedIntType)
    winnerTex.internalFormat = 'R32UI'
    winnerTex.needsUpdate = true
    extraBytes = moves.byteLength + winner.byteLength
    const items = Array.from({ length: 8 }, (_, i) => {
      const it = meta.items[i]
      if (!it) return new THREE.Vector3()
      const type = it.toolType === 'ball_endmill' ? 1 : it.toolType === 'v_bit' ? 2 : it.toolType === 'plasma' ? 3 : 0
      const angle = Math.max(1, Math.min(179, it.vBitAngle ?? 60))
      return new THREE.Vector3(type, it.toolRadius, it.toolType === 'v_bit' ? 1 / Math.tan((angle * Math.PI) / 360) : 0)
    })
    const material = (built.surface as THREE.Mesh).material as THREE.ShaderMaterial
    material.uniforms.uWinner = { value: winnerTex }
    material.uniforms.uMoves = { value: moveTex }
    material.uniforms.uItem = { value: items }
    material.uniforms.uOriginA = { value: new THREE.Vector2(0, 0) }
    material.uniforms.uMoveCount = { value: moveCount }
    const marker = '    float wide = gradientWidening(vec3(vLocal, 0.0));'
    const source = material.fragmentShader
    const at = source.indexOf(marker)
    if (at < 0 || !source.includes('out vec4 fragColor;')) throw new Error('surface shader layout changed')
    material.fragmentShader = source.slice(0, at).replace('out vec4 fragColor;', `out vec4 fragColor;\n${ANALYTIC_HEADER}`) + analyticMain(mode, source.slice(at))
    material.needsUpdate = true
  }

  const camera = new THREE.PerspectiveCamera(45, w / h, 0.01, 1000)
  const cx = cols * cellSize / 2, cz = rows * cellSize / 2
  const span = Math.max(cols, rows) * cellSize
  const view = q.get('view') ?? 'fit'
  if (view === 'fit') {
    camera.position.set(cx - 0.55 * span, 0.85 * span, cz + 0.75 * span)
    camera.lookAt(cx, 0, cz)
  } else {
    // Toolpath (x, y, z) -> world (x, z, y)
    const tx = num('tx', cx), tz = num('tz', cz), d = num('dist', 0.18) * span
    if (view === 'top') camera.position.set(tx, d, tz + 0.0001)
    else camera.position.set(tx - 0.6 * d, 0.9 * d, tz + 0.8 * d)
    camera.lookAt(tx, view === 'top' ? 0 : 0.3, tz)
  }
  const gl = renderer.getContext()
  const px = new Uint8Array(4)
  const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
  for (let i = 0; i < 5; i += 1) { built.outline?.update(renderer); renderer.render(scene, camera); sync() }
  const n = num('n', 60), times: number[] = []
  for (let i = 0; i < n; i += 1) {
    const t0 = performance.now()
    renderer.render(scene, camera)
    sync()
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  const e = gl.getExtension('WEBGL_debug_renderer_info')
  ;(window as unknown as { __bench: unknown }).__bench = {
    median: times[Math.floor(n / 2)], p95: times[Math.floor(n * 0.95)], extraMB: extraBytes / 1e6,
    gpu: e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : '?',
  }
}
run().catch((err) => { (window as unknown as { __bench: unknown }).__bench = { error: String(err) } })
