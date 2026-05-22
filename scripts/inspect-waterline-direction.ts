/**
 * Diagnostic: load a .camj, generate the waterline toolpath for the first
 * waterline op found, then print each closed loop's signed area (sign indicates
 * winding) along with the loop's XY bbox so we can identify which feature
 * (outer wall / pocket / island) each loop belongs to and whether its direction
 * actually flips between climb and conventional.
 *
 * Usage: npx tsx scripts/inspect-waterline-direction.ts work/3d-imported-block-test3.camj
 */

import { readFileSync } from 'node:fs'
import { normalizeProject } from '../src/store/projectStore'
import { generateFinishSurfaceToolpath } from '../src/engine/toolpaths/finishSurface'
import type { ToolpathMove } from '../src/engine/toolpaths/types'

const path = process.argv[2] ?? 'work/3d-imported-block-test3.camj'
const raw = JSON.parse(readFileSync(path, 'utf8'))
const project = normalizeProject(raw)

const waterlineOp = project.operations.find((op) => op.kind === 'finish_surface' && op.pocketPattern === 'waterline')
if (!waterlineOp) {
  console.error('no waterline op found')
  process.exit(1)
}

function extractAllRuns(moves: ToolpathMove[], eps = 1e-6): Array<{ z: number; loop: Array<{ x: number; y: number }>; area: number; bbox: { minX: number; maxX: number; minY: number; maxY: number }; closed: boolean }> {
  const runs: Array<{ z: number; loop: Array<{ x: number; y: number }>; area: number; bbox: { minX: number; maxX: number; minY: number; maxY: number }; closed: boolean }> = []
  let cutRun: Array<{ x: number; y: number }> = []
  let runZ = 0
  const flushAsOpen = (): void => {
    if (cutRun.length >= 2) {
      let area = 0
      for (let i = 0; i < cutRun.length - 1; i += 1) {
        area += cutRun[i].x * cutRun[i + 1].y - cutRun[i + 1].x * cutRun[i].y
      }
      area /= 2
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
      for (const p of cutRun) {
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x
        if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y
      }
      runs.push({ z: runZ, loop: [...cutRun], area, bbox: { minX, maxX, minY, maxY }, closed: false })
    }
    cutRun = []
  }
  const samePoint = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps
  for (const m of moves) {
    if (m.kind !== 'cut' || Math.abs(m.from.z - m.to.z) > eps) {
      flushAsOpen()
      continue
    }
    if (cutRun.length === 0) {
      cutRun.push({ x: m.from.x, y: m.from.y })
      runZ = m.from.z
    }
    cutRun.push({ x: m.to.x, y: m.to.y })
    const here = cutRun[cutRun.length - 1]
    for (let j = 0; j < cutRun.length - 1; j += 1) {
      if (samePoint(cutRun[j], here)) {
        const sub = cutRun.slice(j, cutRun.length)
        let area = 0
        for (let i = 0; i < sub.length - 1; i += 1) {
          area += sub[i].x * sub[i + 1].y - sub[i + 1].x * sub[i].y
        }
        area /= 2
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
        for (const p of sub) {
          if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x
          if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y
        }
        runs.push({ z: runZ, loop: sub, area, bbox: { minX, maxX, minY, maxY }, closed: true })
        cutRun = cutRun.slice(cutRun.length - 1)
        break
      }
    }
  }
  flushAsOpen()
  return runs
}

function extractClosedLoops(moves: ToolpathMove[], eps = 1e-6): Array<{ z: number; loop: Array<{ x: number; y: number }>; area: number; bbox: { minX: number; maxX: number; minY: number; maxY: number } }> {
  const loops: Array<{ z: number; loop: Array<{ x: number; y: number }>; area: number; bbox: { minX: number; maxX: number; minY: number; maxY: number } }> = []
  let cutRun: Array<{ x: number; y: number }> = []
  let runZ = 0
  const samePoint = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps
  const flush = (): void => {
    cutRun = []
  }
  for (const m of moves) {
    if (m.kind !== 'cut' || Math.abs(m.from.z - m.to.z) > eps) {
      flush()
      continue
    }
    if (cutRun.length === 0) {
      cutRun.push({ x: m.from.x, y: m.from.y })
      runZ = m.from.z
    }
    cutRun.push({ x: m.to.x, y: m.to.y })
    // Detect closure to any earlier point in this run.
    const here = cutRun[cutRun.length - 1]
    for (let j = 0; j < cutRun.length - 1; j += 1) {
      if (samePoint(cutRun[j], here)) {
        const sub = cutRun.slice(j, cutRun.length)
        let area = 0
        for (let i = 0; i < sub.length - 1; i += 1) {
          area += sub[i].x * sub[i + 1].y - sub[i + 1].x * sub[i].y
        }
        area /= 2
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
        for (const p of sub) {
          if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x
          if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y
        }
        loops.push({ z: runZ, loop: sub, area, bbox: { minX, maxX, minY, maxY } })
        cutRun = cutRun.slice(cutRun.length - 1)
        break
      }
    }
  }
  return loops
}

for (const direction of ['conventional', 'climb'] as const) {
  const op = { ...waterlineOp, cutDirection: direction }
  const result = generateFinishSurfaceToolpath(project, op)
  console.log(`\n=== cutDirection = ${direction} ===`)
  if (result.warnings.length > 0) console.log('warnings:', result.warnings)
  const runs = extractAllRuns(result.moves)
  runs.sort((a, b) => b.z - a.z || a.bbox.minX - b.bbox.minX)
  let lastZ = NaN
  for (const lp of runs) {
    if (lp.z !== lastZ) {
      console.log(`  --- z=${lp.z.toFixed(3)} ---`)
      lastZ = lp.z
    }
    const winding = lp.area > 0 ? 'CCW' : 'CW'
    const span = `[${lp.bbox.minX.toFixed(2)},${lp.bbox.maxX.toFixed(2)}]×[${lp.bbox.minY.toFixed(2)},${lp.bbox.maxY.toFixed(2)}]`
    const kind = lp.closed ? 'closed' : 'OPEN  '
    console.log(`    ${kind} bbox=${span} pts=${lp.loop.length} area=${lp.area.toFixed(3)} → ${winding}`)
  }
}
