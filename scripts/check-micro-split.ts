import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Monkey-patch to see what emitCollapseGeometry receives
const origPath = path.resolve('src/engine/toolpaths/vcarveRecursive.ts')
let content = fs.readFileSync(origPath, 'utf8')

// Find the emitCollapseGeometry function and add logging
// We'll just instrument it via the test file approach
import { generateVCarveRecursiveToolpath } from '../src/engine/toolpaths/vcarveRecursive.ts'
import { ClipperLib } from 'clipper-lib'
import type { Project } from '../src/types/project.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectPath = path.resolve(here, '../../purecutcnc/work/v-carve-skeleton-tests.camj')
const project = JSON.parse(fs.readFileSync(projectPath, 'utf8')) as Project

const op = project.operations.find((o: any) => o.id === 'op0006')!
const result = generateVCarveRecursiveToolpath(project, op)
console.log(`C (op0006): ${result.moves.length} moves`)
console.log(`warnings: ${result.warnings.join(', ')}`)
