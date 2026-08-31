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

// Opt-in local diagnostic panel; never injected by the production app.
const panel = document.createElement('details')
panel.open = true
panel.style.cssText = 'position:fixed;bottom:4px;left:4px;z-index:99999;background:#fff;color:#111;padding:8px;border:1px solid #777;max-width:460px;font:12px monospace'
panel.innerHTML = '<summary>Issue 683 baseline</summary><button id="b683-rect">Load rectangle</button> <button id="b683-raster">Load raster</button> <button id="b683-arm">Capture next gesture</button><label>Capture label <input id="b683-label" value="fit" /></label><pre id="b683-result" style="max-height:190px;overflow:auto;white-space:pre-wrap">Ready</pre>'
document.body.append(panel)
const output = panel.querySelector('pre')
let fixture = 'unloaded'
let armed = false
let recording = null
let finishTimer
const results = []
function summarize(times) {
  const gaps = times.slice(1).map((time, i) => time - times[i])
  const sorted = [...gaps].sort((a,b) => a-b)
  return { samples: gaps.length, durationMs: times.length > 1 ? times.at(-1) - times[0] : 0,
    medianMs: sorted[Math.floor(sorted.length / 2)] ?? null,
    p95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? null,
    maxMs: sorted.at(-1) ?? null }
}
function finish() {
  if (!recording) return
  const run = recording
  recording = null
  const canvas = document.querySelector('canvas.sketch-canvas')
  const result = { fixture, gesture: run.gesture, trustedInput: run.trusted, userAgent: navigator.userAgent,
    directions: run.directions, renderer: run.renderer, label: run.label,
    gpuStats: document.querySelector('canvas.sketch-toolpath-gpu')?.dataset.pocStats ?? null,
    recordedAt: new Date().toISOString(),
    dpr: devicePixelRatio, viewport: [innerWidth, innerHeight], canvas: [canvas.width, canvas.height],
    gestureDurationMs: run.lastInput - run.start,
    animationFrames: summarize(run.raf.filter(t => t >= run.start && t <= run.lastInput)),
    canvasPaints: summarize(run.paint.filter(t => t <= run.lastInput)),
    settlingPaintDelaysMs: run.paint.filter(t => t > run.lastInput).map(t => t - run.lastInput),
    inputEvents: run.input.length, inputTimes: run.input, rafTimes: run.raf, paintTimes: run.paint }
  results.push(result)
  output.textContent = JSON.stringify({ ...result, inputTimes: undefined, rafTimes: undefined, paintTimes: undefined }, null, 2)
  const data = document.getElementById('b683-data') ?? document.createElement('script')
  data.id = 'b683-data'; data.type = 'application/json'; data.textContent = JSON.stringify(results)
  panel.append(data)
  panel.open = true
}
function begin(event, gesture) {
  if (!armed && !recording) return
  const now = performance.now()
  if (!recording) {
    armed = false
    recording = { start: now, lastInput: now, gesture, trusted: event.isTrusted, input: [], raf: [], paint: [],
      directions: [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Directions')?.getAttribute('aria-pressed'),
      renderer: document.querySelector('canvas.sketch-canvas')?.dataset.toolpathRenderer ?? 'canvas',
      label: panel.querySelector('#b683-label').value }
    const run = recording
    const frame = time => { if (recording !== run) return; run.raf.push(time); requestAnimationFrame(frame) }
    requestAnimationFrame(frame)
  }
  recording.input.push(now)
  recording.lastInput = now
}
const clear = CanvasRenderingContext2D.prototype.clearRect
CanvasRenderingContext2D.prototype.clearRect = function (...args) {
  if (recording && this.canvas.matches('canvas.sketch-canvas')) recording.paint.push(performance.now())
  return clear.apply(this, args)
}
document.addEventListener('pointerdown', event => {
  if (event.target.matches?.('canvas.sketch-canvas') && (event.shiftKey || event.button === 1 || event.button === 2)) begin(event, 'pan')
}, true)
document.addEventListener('pointermove', event => {
  if (recording?.gesture === 'pan' && !recording.released) begin(event, 'pan')
}, true)
document.addEventListener('pointerup', event => {
  if (recording?.gesture !== 'pan') return
  recording.lastInput = performance.now()
  recording.released = true
  clearTimeout(finishTimer); finishTimer = setTimeout(finish, 500)
}, true)
document.addEventListener('wheel', event => {
  if (!event.target.matches?.('canvas.sketch-canvas')) return
  begin(event, 'wheel')
  if (recording) { clearTimeout(finishTimer); finishTimer = setTimeout(finish, 500) }
}, { capture: true, passive: true })
panel.querySelector('#b683-arm').onclick = () => {
  if (recording) finish()
  armed = true; output.textContent = 'Armed: use Shift-drag or wheel on the sketch canvas'; panel.open = false
}
async function load(name) {
  output.textContent = 'Loading ' + name
  try {
    const response = await fetch('/src/engine/test-fixtures/' + name)
    if (!response.ok) throw new Error(response.statusText)
    await window.__pcTest.loadProject(await response.text())
    fixture = name
    output.textContent = 'Loaded ' + name + '. Select its operation; wait for toolpaths; then capture.'
  } catch (error) { output.textContent = String(error) }
}
panel.querySelector('#b683-rect').onclick = () => load('trochoidal-249k.camj')
panel.querySelector('#b683-raster').onclick = () => load('trochoidal-raster.camj')
const alphaButton = document.createElement('button')
alphaButton.textContent = 'Alpha swatch'
panel.append(alphaButton)
alphaButton.onclick = async () => {
  const { GpuToolpathRenderer } = await import('/src/components/canvas/gpuToolpathRenderer.ts')
  const { drawToolpath } = await import('/src/components/canvas/previewPrimitives.ts')
  const { canvasColors } = await import('/src/components/canvas/canvasPalette.ts')
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;top:120px;left:270px;z-index:99999;background:#222;padding:12px;color:white'
  const oracle = document.createElement('canvas'), gpuCanvas = document.createElement('canvas')
  oracle.width = gpuCanvas.width = 320; oracle.height = gpuCanvas.height = 140
  host.append('Canvas | GPU (1000 coincident cuts, crossing, separate segment)', document.createElement('br'), oracle, gpuCanvas)
  document.body.append(host)
  const from = {x:20,y:40,z:0}, to = {x:280,y:40,z:0}
  const moves = Array.from({length:1000}, () => ({kind:'cut',from,to}))
  moves.push({kind:'cut',from:{x:150,y:15,z:0},to:{x:150,y:65,z:0}})
  moves.push({kind:'cut',from:{x:20,y:100,z:0},to:{x:280,y:100,z:0}})
  const toolpath = {operationId:'alpha-diagnostic', moves, warnings:[],bounds:null}
  const visibility = {cuts:true,leadIns:true,rapids:true,plunges:true,retractions:true,directions:false,feedColours:false}
  const vt = {scale:1,offsetX:0,offsetY:0}
  drawToolpath(oracle.getContext('2d'),toolpath,vt,false,visibility,1,{simplifyForDisplay:false})
  const gpu = new GpuToolpathRenderer(gpuCanvas,()=>{})
  gpu.render([{toolpath,emphasized:false,slotScale:1}],vt,320,140,visibility,canvasColors())
  const readback = document.createElement('canvas');readback.width=320;readback.height=140
  const readCtx=readback.getContext('2d');readCtx.drawImage(gpuCanvas,0,0)
  const samples = [ [60,40], [150,40], [60,100] ].map(([x,y]) => ({x,y,canvas:[...oracle.getContext('2d').getImageData(x,y,1,1).data],gpu:[...readCtx.getImageData(x,y,1,1).data]}))
  const pre = document.createElement('pre');pre.id='b683-alpha';pre.textContent=JSON.stringify(samples);host.append(pre)
  const close=document.createElement('button');close.textContent='Close alpha swatch';close.onclick=()=>{gpu.dispose();host.remove()};host.append(close)
}
