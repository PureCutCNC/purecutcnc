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
 * Visual comparison: V-Carve skeleton (v_carve_recursive) vs V-Carve medial
 * (v_carve_medial) on real font text, a sharp star, and a ring.
 *
 * Renders side-by-side SVGs with cuts colored by depth (blue shallow → red
 * deep) plus a medial-axis-graph overlay, and prints move counts and timing.
 *
 * Run: npx tsx scripts/vcarve-medial-preview.ts [outputDir]
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Operation, Point, Project, SketchFeature, Tool } from '../src/types/project'
import { defaultTool, inferFeatureKind, newProject, polygonProfile, profileVertices } from '../src/types/project'
import { defaultTextToolConfig, generateTextShapes, getTextFontOptions } from '../src/text'
import { generateVCarveRecursiveToolpath } from '../src/engine/toolpaths/vcarveRecursive'
import { generateVCarveMedialToolpath } from '../src/engine/toolpaths/vcarveMedial'
import type { ToolpathMove } from '../src/engine/toolpaths/types'

const outDir = process.argv[2] ?? 'work/vcarve-medial-preview'
mkdirSync(outDir, { recursive: true })

// ---------------------------------------------------------------------------
// Project scaffolding
// ---------------------------------------------------------------------------

function makeVBit(): Tool {
  return { ...defaultTool('mm', 1), id: 't1', name: '60° V-bit', type: 'v_bit', vBitAngle: 60, diameter: 12, maxCutDepth: 12 }
}

function featureFromPolygon(id: string, points: Point[], zBottom: number): SketchFeature {
  return {
    id,
    name: id,
    kind: 'polygon',
    folderId: null,
    sketch: {
      profile: polygonProfile(points),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'subtract',
    z_top: 0,
    z_bottom: zBottom,
    visible: true,
    locked: false,
  }
}

function makeOp(kind: Operation['kind'], featureIds: string[], stepover: number, maxCarveDepth: number): Operation {
  return {
    id: `op-${kind}`,
    name: kind,
    kind,
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds },
    toolRef: 't1',
    stepdown: 2,
    stepover,
    feed: 800,
    plungeFeed: 300,
    rpm: 18000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
    carveDepth: 1,
    maxCarveDepth,
    cutDirection: 'conventional',
    machiningOrder: 'level_first',
  }
}

function baseProject(features: SketchFeature[]): Project {
  return { ...newProject('preview', 'mm'), tools: [makeVBit()], features }
}

// ---------------------------------------------------------------------------
// Test shapes
// ---------------------------------------------------------------------------

function star(cx: number, cy: number, outerR: number, innerR: number, points: number): Point[] {
  const pts: Point[] = []
  for (let i = 0; i < points * 2; i += 1) {
    const r = i % 2 === 0 ? outerR : innerR
    const a = (Math.PI * i) / points - Math.PI / 2
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
  }
  return pts
}

function ringFeatures(): SketchFeature[] {
  const outer = Array.from({ length: 96 }, (_, i) => {
    const a = (2 * Math.PI * i) / 96
    return { x: 25 + 20 * Math.cos(a), y: 25 + 20 * Math.sin(a) }
  })
  const inner = Array.from({ length: 96 }, (_, i) => {
    const a = (2 * Math.PI * i) / 96
    return { x: 25 + 12 * Math.cos(a), y: 25 + 12 * Math.sin(a) }
  })
  const outerFeature = featureFromPolygon('ring-outer', outer, -8)
  const innerFeature = { ...featureFromPolygon('ring-inner', inner, -8), operation: 'add' as const }
  return [outerFeature, innerFeature]
}

function textFeatures(text: string): { features: SketchFeature[]; fontLabel: string } {
  const fonts = getTextFontOptions('outline')
  const serif = fonts.find((f) => /serif|roman|times/i.test(f.label) && !/sans/i.test(f.label)) ?? fonts[0]
  const config = { ...defaultTextToolConfig('mm'), text, style: 'outline' as const, fontId: serif.id, size: 30, operation: 'subtract' as const }
  const shapes = generateTextShapes(config, { x: 5, y: 40 })
  const features = shapes.map((shape, i): SketchFeature => ({
    id: `glyph-${i}`,
    name: shape.name,
    kind: inferFeatureKind(shape.profile),
    folderId: null,
    sketch: { profile: shape.profile, origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation: shape.operation,
    z_top: 0,
    z_bottom: -8,
    visible: true,
    locked: false,
  }))
  return { features, fontLabel: serif.label }
}

// ---------------------------------------------------------------------------
// SVG rendering
// ---------------------------------------------------------------------------

interface Bounds { minX: number; minY: number; maxX: number; maxY: number }

function depthColor(depth: number, maxDepth: number): string {
  const t = Math.max(0, Math.min(1, maxDepth > 0 ? depth / maxDepth : 0))
  const hue = 220 - 220 * t // blue → red
  return `hsl(${hue.toFixed(0)}, 90%, ${50 - 15 * t}%)`
}

function svgPanel(
  title: string,
  featurePolys: Point[][],
  moves: ToolpathMove[],
  bounds: Bounds,
  maxDepth: number,
  stats: string,
): string {
  const pad = 4
  const w = bounds.maxX - bounds.minX + pad * 2
  const h = bounds.maxY - bounds.minY + pad * 2
  const tx = (x: number): string => (x - bounds.minX + pad).toFixed(3)
  const ty = (y: number): string => (y - bounds.minY + pad).toFixed(3)

  const parts: string[] = []
  parts.push(`<text x="${pad}" y="${(-1.2).toFixed(2)}" font-size="3.2" font-family="monospace" fill="#333">${title}</text>`)
  parts.push(`<text x="${pad}" y="${(h + 3.4).toFixed(2)}" font-size="2.2" font-family="monospace" fill="#666">${stats}</text>`)
  for (const poly of featurePolys) {
    const d = poly.map((p, i) => `${i === 0 ? 'M' : 'L'}${tx(p.x)},${ty(p.y)}`).join(' ') + ' Z'
    parts.push(`<path d="${d}" fill="none" stroke="#000" stroke-width="0.15" />`)
  }
  for (const move of moves) {
    if (move.kind !== 'cut' && move.kind !== 'plunge') continue
    if (move.kind === 'plunge') {
      parts.push(`<circle cx="${tx(move.to.x)}" cy="${ty(move.to.y)}" r="0.25" fill="#0a0" fill-opacity="0.5" />`)
      continue
    }
    const depth = -(move.from.z + move.to.z) / 2
    parts.push(
      `<line x1="${tx(move.from.x)}" y1="${ty(move.from.y)}" x2="${tx(move.to.x)}" y2="${ty(move.to.y)}"`
      + ` stroke="${depthColor(depth, maxDepth)}" stroke-width="0.3" stroke-linecap="round" />`,
    )
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -5 ${w.toFixed(2)} ${(h + 10).toFixed(2)}" width="${(w * 8).toFixed(0)}" height="${((h + 10) * 8).toFixed(0)}">`
    + `<rect x="0" y="-5" width="${w.toFixed(2)}" height="${(h + 10).toFixed(2)}" fill="#fff"/>`
    + parts.join('\n') + '</svg>'
}

function movesBounds(featurePolys: Point[][]): Bounds {
  const b: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  for (const poly of featurePolys) {
    for (const p of poly) {
      b.minX = Math.min(b.minX, p.x)
      b.minY = Math.min(b.minY, p.y)
      b.maxX = Math.max(b.maxX, p.x)
      b.maxY = Math.max(b.maxY, p.y)
    }
  }
  return b
}

function featurePolysOf(features: SketchFeature[]): Point[][] {
  return features.map((f) => profileVertices(f.sketch.profile))
}

// ---------------------------------------------------------------------------
// Comparison driver
// ---------------------------------------------------------------------------

function silence<T>(fn: () => T): T {
  const original = console.log
  console.log = () => {}
  try {
    return fn()
  } finally {
    console.log = original
  }
}

function runCaseAsFiles(name: string, features: SketchFeature[], stepover: number, maxCarveDepth: number, note = ''): string[] {
  const project = baseProject(features)
  const featureIds = features.map((f) => f.id)
  const polys = featurePolysOf(features)
  const bounds = movesBounds(polys)

  const t0 = performance.now()
  const oldResult = silence(() => generateVCarveRecursiveToolpath(project, makeOp('v_carve_recursive', featureIds, stepover, maxCarveDepth)))
  const t1 = performance.now()
  const newResult = silence(() => generateVCarveMedialToolpath(project, makeOp('v_carve_medial', featureIds, stepover, maxCarveDepth)))
  const t2 = performance.now()

  const cutCount = (moves: ToolpathMove[]): number => moves.filter((m) => m.kind === 'cut').length
  const retracts = (moves: ToolpathMove[]): number => moves.filter((m) => m.kind === 'rapid' && m.to.z > m.from.z).length
  const oldStats = `${cutCount(oldResult.moves)} cuts · ${retracts(oldResult.moves)} retracts · ${(t1 - t0).toFixed(0)} ms · ${oldResult.warnings.length} warnings`
  const newStats = `${cutCount(newResult.moves)} cuts · ${retracts(newResult.moves)} retracts · ${(t2 - t1).toFixed(0)} ms · ${newResult.warnings.length} warnings`
  console.info(`[${name}] skeleton(old): ${oldStats}`)
  console.info(`[${name}] medial(new):  ${newStats}`)
  for (const w of oldResult.warnings) console.info(`  old warning: ${w}`)
  for (const w of newResult.warnings) console.info(`  new warning: ${w}`)

  const files: string[] = []
  const oldFile = `${name}-old-skeleton.svg`
  const newFile = `${name}-new-medial.svg`
  writeFileSync(join(outDir, oldFile), svgPanel(`${name} — V-Carve skeleton (current) ${note}`, polys, oldResult.moves, bounds, maxCarveDepth, oldStats))
  writeFileSync(join(outDir, newFile), svgPanel(`${name} — V-Carve medial (new) ${note}`, polys, newResult.moves, bounds, maxCarveDepth, newStats))
  files.push(oldFile, newFile)
  return files
}

// ---------------------------------------------------------------------------
// Run all cases
// ---------------------------------------------------------------------------

const allFiles: string[] = []

const text = textFeatures('Rag')
console.info(`text font: ${text.fontLabel}, ${text.features.length} glyph contours`)
allFiles.push(...runCaseAsFiles('text-Rag', text.features, 0.25, 8, `(font: ${text.fontLabel})`))

allFiles.push(...runCaseAsFiles('star', [featureFromPolygon('star', star(25, 25, 22, 9, 5), -10)], 0.25, 10))

allFiles.push(...runCaseAsFiles('ring', ringFeatures(), 0.25, 8))

const lShape: Point[] = [
  { x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 12 }, { x: 12, y: 12 }, { x: 12, y: 40 }, { x: 0, y: 40 },
]
allFiles.push(...runCaseAsFiles('L-shape', [featureFromPolygon('L', lShape, -10)], 0.25, 10))

const html = `<!doctype html><meta charset="utf-8"><title>V-Carve medial preview</title>
<style>body{font-family:monospace;background:#eee;margin:20px} .row{display:flex;gap:12px;margin-bottom:24px;flex-wrap:wrap} img{background:#fff;border:1px solid #ccc;max-width:48%}</style>
<h1>V-Carve: skeleton (old) vs medial (new)</h1>
${['text-Rag', 'star', 'ring', 'L-shape'].map((n) => `<div class="row"><img src="${n}-old-skeleton.svg"><img src="${n}-new-medial.svg"></div>`).join('\n')}
`
writeFileSync(join(outDir, 'index.html'), html)
console.info(`\nwrote ${allFiles.length} SVGs + index.html to ${outDir}`)
