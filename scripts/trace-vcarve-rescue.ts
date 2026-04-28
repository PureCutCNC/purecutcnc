import fs from 'node:fs'
import { generateVCarveRecursiveToolpath, setRescueTracer } from '../src/engine/toolpaths/vcarveRecursive.ts'
import type { Operation, Project } from '../src/types/project.ts'

const PROJECT_PATH = process.env.CAMJ_PATH ?? '/Users/frankp/Projects/purecutcnc/work/v-carve-skeleton-tests.camj'
const OPERATION_ID = process.env.OP_ID ?? 'op0006'
const project = JSON.parse(fs.readFileSync(PROJECT_PATH, 'utf8')) as Project
const operation = project.operations.find((entry) => entry.id === OPERATION_ID) as Operation | undefined
if (!operation) throw new Error(`${OPERATION_ID} not found`)
console.log(`project=${PROJECT_PATH} op=${OPERATION_ID}`)

const events: Array<Record<string, unknown>> = []
let activeArm: Record<string, unknown> | null = null
let activeSteps: Array<Record<string, unknown>> = []

const fallbackHits: Array<Record<string, unknown>> = []
const fallbackMisses: Array<Record<string, unknown>> = []
setRescueTracer((event) => {
  if (event.kind === 'rescue:start') {
    const arm = event.armPoint as { x: number, y: number }
    if (arm.x >= 2.04 && arm.x <= 2.06 && arm.y >= 1.06 && arm.y <= 1.08) {
      const guide = event.guide as { x: number, y: number }
      console.log(
        `[rescue:start target] arm=(${arm.x.toFixed(4)},${arm.y.toFixed(4)}) `
        + `guide=(${guide.x.toFixed(4)},${guide.y.toFixed(4)})`,
      )
    }
    activeArm = event
    activeSteps = []
    return
  }
  if (event.kind === 'rescue:step') {
    activeSteps.push(event)
    return
  }
  if (event.kind === 'rescue:bail' || event.kind === 'rescue:snap') {
    if (event.kind === 'rescue:snap') {
      const terminal = event as Record<string, unknown>
      const snapTo = terminal.snapTo as { x: number, y: number } | undefined
      if (snapTo && snapTo.x >= 2.04 && snapTo.x <= 2.06 && snapTo.y >= 1.06 && snapTo.y <= 1.08) {
        const arm = (activeArm?.armPoint as { x: number, y: number } | undefined)
        console.log(
          `[rescue:snap to target] from=(${arm?.x?.toFixed(4)},${arm?.y?.toFixed(4)}) `
          + `to=(${snapTo.x.toFixed(4)},${snapTo.y.toFixed(4)}) steps=${activeSteps.length}`,
        )
      }
    }
    events.push({ ...activeArm, kind: event.kind, terminal: event, stepCount: activeSteps.length, lastStep: activeSteps[activeSteps.length - 1] ?? null, allSteps: activeSteps })
    activeArm = null
    activeSteps = []
    return
  }
  if (event.kind === 'fallback:hit') fallbackHits.push(event)
  if (event.kind === 'fallback:wall-miss') {
    const arm = event.arm as { x: number, y: number }
    if (arm.x >= 2.04 && arm.x <= 2.06 && arm.y >= 1.06 && arm.y <= 1.08) {
      const target = event.target as { x: number, y: number }
      console.log(
        `[fallback:wall-miss target] arm=(${arm.x.toFixed(4)},${arm.y.toFixed(4)}) `
        + `target=(${target.x.toFixed(4)},${target.y.toFixed(4)}) `
        + `dist=${(event.dist as number).toFixed(4)} budget=${(event.budget as number).toFixed(4)} `
        + `inside=${String(event.inside)}`,
      )
    }
  }
  if (event.kind === 'fallback:miss') fallbackMisses.push(event)
  if (event.kind === 'bootstrap:miss') {
    const fs = event.freshSeed as { x: number, y: number }
    if (fs.x >= 2.04 && fs.x <= 2.06 && fs.y >= 1.06 && fs.y <= 1.08) {
      console.log(`[bootstrap:miss target] freshSeed=(${fs.x.toFixed(4)},${fs.y.toFixed(4)}) reason=${event.reason} sourceArmCount=${event.sourceArmCount}`)
    }
  }
  if (event.kind === 'bootstrap:start') {
    const fs = event.freshSeed as { x: number, y: number }
    if (fs.x >= 2.04 && fs.x <= 2.06 && fs.y >= 1.06 && fs.y <= 1.08) {
      console.log(`[bootstrap:start target] freshSeed=(${fs.x.toFixed(4)},${fs.y.toFixed(4)}) sourceArmCount=${event.sourceArmCount}`)
    }
  }
})

const result = generateVCarveRecursiveToolpath(project, operation)
setRescueTracer(null)

const bails = events.filter((e) => e.kind === 'rescue:bail')
const snaps = events.filter((e) => e.kind === 'rescue:snap')
const probeOutside = events.filter((e) => {
  const steps = (e.allSteps as Array<Record<string, unknown>>) ?? []
  return steps.some((s) => s.probeInside === false)
})

console.log(`total rescues: ${events.length}`)
console.log(`  snaps (success): ${snaps.length}`)
console.log(`  bails: ${bails.length}`)
console.log(`fallback hits: ${fallbackHits.length}`)
console.log(`fallback misses (truly unconnected): ${fallbackMisses.length}`)
console.log('--- fallback misses (first 15) ---')
for (const m of fallbackMisses.slice(0, 15)) {
  const arm = m.arm as { x: number, y: number }
  const d = m.nearestDist as number
  console.log(`miss arm=(${arm.x.toFixed(4)},${arm.y.toFixed(4)}) candidates=${m.candidateCornerCount} nearestDist=${Number.isFinite(d) ? d.toFixed(4) : 'inf'}`)
}
console.log(`  rescues with probe-outside-contour at any iter: ${probeOutside.length}`)

const bailReasons = new Map<string, number>()
for (const e of bails) {
  const r = ((e.terminal as Record<string, unknown>).reason as string) ?? 'unknown'
  bailReasons.set(r, (bailReasons.get(r) ?? 0) + 1)
}
console.log('bail reasons:', Object.fromEntries(bailReasons))

console.log('\n--- sample bails (first 10) ---')
for (const e of bails.slice(0, 10)) {
  const arm = e.armPoint as { x: number, y: number }
  const t = e.terminal as Record<string, unknown>
  console.log(`bail reason=${t.reason} arm=(${arm.x.toFixed(4)},${arm.y.toFixed(4)}) iter=${t.iteration} steps=${e.stepCount}`)
  if (t.probeInside === false) console.log(`  probe OUTSIDE contour: ${JSON.stringify(t.probe)}`)
  if (t.reason === 'low-progress') console.log(`  forwardProgress=${t.forwardProgress} stepSize=${t.stepSize} radius=${t.radius}`)
}

console.log('\n--- snaps with multi-step rescue (>3 iters) ---')
const multiStepSnaps = snaps.filter((s) => (s.stepCount as number) > 3)
console.log(`count: ${multiStepSnaps.length}`)
for (const e of multiStepSnaps.slice(0, 5)) {
  const arm = e.armPoint as { x: number, y: number }
  const t = e.terminal as Record<string, unknown>
  const snapTo = t.snapTo as { x: number, y: number }
  console.log(`snap arm=(${arm.x.toFixed(4)},${arm.y.toFixed(4)}) -> (${snapTo.x.toFixed(4)},${snapTo.y.toFixed(4)}) steps=${e.stepCount} snapDist=${(t.snapDist as number).toFixed(4)}`)
  for (const step of (e.allSteps as Array<Record<string, unknown>>)) {
    const ch = step.channel as { x: number, y: number }
    console.log(`    step=${step.iteration} channel=(${ch.x.toFixed(4)},${ch.y.toFixed(4)}) probeInside=${step.probeInside} radius=${(step.radius as number).toFixed(5)} forward=${(step.forwardProgress as number).toFixed(5)}`)
  }
}

console.log(`\nresult moves=${result.moves.length} warnings=${result.warnings.join(' | ')}`)
