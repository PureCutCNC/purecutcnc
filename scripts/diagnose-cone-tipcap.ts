/**
 * Diagnostic for issue #127: tip-cap quality on cone apex.
 *
 * Loads a project file, runs the finish_surface waterline operation, and
 * groups the resulting cut moves by `source` and Z to characterise the
 * tip-cap rings (source='projectedCap') the algorithm produced.
 *
 * Usage: npx tsx scripts/diagnose-cone-tipcap.ts work/Cone.camj
 */
import fs from 'node:fs'
import type { Project } from '../src/types/project.ts'
import { generateFinishSurfaceToolpath } from '../src/engine/toolpaths/finishSurface.ts'
import type { ToolpathMove } from '../src/engine/toolpaths/types.ts'

const projectPath = process.argv[2]
if (!projectPath) {
  console.error('Usage: npx tsx scripts/diagnose-cone-tipcap.ts <project.camj>')
  process.exit(1)
}

;(globalThis as { __DBG127?: boolean }).__DBG127 = true

const project = JSON.parse(fs.readFileSync(projectPath, 'utf8')) as Project

const finishOps = project.operations.filter((op) => op.kind === 'finish_surface')
console.log(`finish_surface operations: ${finishOps.length}`)

function cutBounds(moves: ToolpathMove[]) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  let minZ = Infinity, maxZ = -Infinity
  let count = 0
  for (const move of moves) {
    if (move.kind !== 'cut') continue
    count += 1
    for (const p of [move.from, move.to]) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y
      if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z
    }
  }
  return { count, minX, maxX, minY, maxY, minZ, maxZ }
}

function fmt(n: number): string {
  return Number.isFinite(n) ? n.toFixed(4) : 'n/a'
}

for (const op of finishOps) {
  console.log(`\n=== ${op.id} ${op.name} ===`)
  const opWithDebug = { ...op, debugToolpath: true }
  const result = generateFinishSurfaceToolpath(project, opWithDebug)
  console.log(`total moves: ${result.moves.length}`)
  console.log(`warnings:`)
  for (const w of result.warnings) console.log(`  - ${w}`)

  const bySource = new Map<string, ToolpathMove[]>()
  for (const m of result.moves) {
    if (m.kind !== 'cut') continue
    const key = m.source ?? '(none)'
    if (!bySource.has(key)) bySource.set(key, [])
    bySource.get(key)!.push(m)
  }
  console.log(`\nCut moves by source:`)
  for (const [src, ms] of [...bySource.entries()].sort()) {
    const b = cutBounds(ms)
    console.log(`  ${src.padEnd(22)} ${b.count.toString().padStart(5)} moves  z=${fmt(b.minZ)}..${fmt(b.maxZ)}  xy=[${fmt(b.minX)},${fmt(b.minY)}]-[${fmt(b.maxX)},${fmt(b.maxY)}]`)
  }

  // Detailed look at projectedCap moves: group by ring (contiguous run of
  // 'cut' moves with same source) and report each ring's z range and
  // approximate radius.
  const capMoves = result.moves.filter((m) => m.kind === 'cut' && m.source === 'projectedCap')
  console.log(`\nprojectedCap rings (contiguous cut runs):`)
  let ring: ToolpathMove[] = []
  const rings: ToolpathMove[][] = []
  let lastTo: { x: number; y: number; z: number } | null = null
  for (const m of capMoves) {
    if (m.kind !== 'cut') continue
    const continuing = lastTo && Math.hypot(m.from.x - lastTo.x, m.from.y - lastTo.y) < 1e-4
      && Math.abs(m.from.z - lastTo.z) < 1e-4
    if (!continuing && ring.length > 0) {
      rings.push(ring)
      ring = []
    }
    ring.push(m)
    lastTo = m.to
  }
  if (ring.length > 0) rings.push(ring)
  console.log(`  ${rings.length} rings`)
  for (let i = 0; i < rings.length; i += 1) {
    const r = rings[i]
    const b = cutBounds(r)
    const cx = (b.minX + b.maxX) / 2
    const cy = (b.minY + b.maxY) / 2
    const rx = (b.maxX - b.minX) / 2
    const ry = (b.maxY - b.minY) / 2
    console.log(`    ring ${i.toString().padStart(2)}: ${r.length.toString().padStart(4)} moves  z=${fmt(b.minZ)}..${fmt(b.maxZ)}  ctr=(${fmt(cx)},${fmt(cy)})  half-extent=(${fmt(rx)},${fmt(ry)})`)
  }

  if (rings.length > 0) {
    const apexZ = Math.max(...rings.map((r) => cutBounds(r).maxZ))
    console.log(`\nhighest projectedCap z: ${fmt(apexZ)}`)
  }

  // What are the highest cut moves overall? An apex problem looks like a flat
  // plateau at some Z just below the true cone tip.
  const cutMoves = result.moves.filter((m) => m.kind === 'cut')
  const topZ = cutMoves.reduce((acc, m) => Math.max(acc, m.from.z, m.to.z), -Infinity)
  console.log(`overall highest cut z: ${fmt(topZ)}`)
  const nearTop = cutMoves.filter((m) => Math.max(m.from.z, m.to.z) >= topZ - 0.005)
  console.log(`cuts within 0.005 of top: ${nearTop.length}`)
  const nearTopSources = new Map<string, number>()
  for (const m of nearTop) {
    const k = m.source ?? '(none)'
    nearTopSources.set(k, (nearTopSources.get(k) ?? 0) + 1)
  }
  for (const [k, n] of nearTopSources) console.log(`  ${k}: ${n}`)
}
