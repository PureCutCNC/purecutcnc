/**
 * Deterministic line-range file editor for agents.
 *
 * Exact-match edit tools fail when a model cannot reproduce file content
 * byte-for-byte, and the usual fallback — chained `sed -i` regexes — mutates
 * files invisibly and globally. This tool replaces both failure modes with
 * explicit, verifiable line operations:
 *
 *   npx tsx scripts/edit-lines.ts show <file> <start> <end>
 *       Print the lines with line numbers (re-read before every edit).
 *   npx tsx scripts/edit-lines.ts replace <file> <start> <end> [--expect <substring>] < new-content
 *       Replace inclusive 1-indexed line range with stdin content.
 *   npx tsx scripts/edit-lines.ts insert-after <file> <line> < new-content
 *       Insert stdin content after the given line (0 = top of file).
 *   npx tsx scripts/edit-lines.ts delete <file> <start> <end> [--expect <substring>]
 *       Delete the inclusive line range.
 *   npx tsx scripts/edit-lines.ts --self-test
 *
 * Safety properties: refuses out-of-range line numbers; `--expect` aborts the
 * edit unless the CURRENT text of the range contains the given substring
 * (guards against stale line numbers); every edit prints an old/new diff of
 * exactly what changed; writes are atomic (temp file + rename); trailing
 * newline presence is preserved. Never edits more than the addressed range.
 */

import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

function fail(message: string): never {
  console.error(`edit-lines: ${message}`)
  process.exit(2)
}

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

interface FileLines {
  lines: string[]
  trailingNewline: boolean
}

function readLines(path: string): FileLines {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    fail(`cannot read file: ${path}`)
  }
  const trailingNewline = raw.endsWith('\n')
  const body = trailingNewline ? raw.slice(0, -1) : raw
  return { lines: body === '' ? [] : body.split('\n'), trailingNewline }
}

function writeLines(path: string, file: FileLines): void {
  const raw = file.lines.join('\n') + (file.trailingNewline ? '\n' : '')
  const dir = dirname(path)
  const tmp = join(dir, `.edit-lines-${process.pid}.tmp`)
  writeFileSync(tmp, raw, 'utf8')
  renameSync(tmp, path)
}

function checkRange(file: FileLines, start: number, end: number): void {
  if (!Number.isInteger(start) || !Number.isInteger(end)) fail('line numbers must be integers')
  if (start < 1) fail(`start must be >= 1 (got ${start})`)
  if (end < start) fail(`end (${end}) must be >= start (${start})`)
  if (end > file.lines.length) fail(`end (${end}) is past the last line (${file.lines.length})`)
}

function numbered(lines: string[], firstNumber: number): string {
  return lines.map((line, i) => `${String(firstNumber + i).padStart(5)}\t${line}`).join('\n')
}

function printDiff(oldLines: string[], oldStart: number, newLines: string[]): void {
  console.log('--- removed:')
  console.log(oldLines.length ? numbered(oldLines, oldStart).replace(/^/gm, '- ') : '  (none)')
  console.log('+++ inserted:')
  console.log(newLines.length ? newLines.map((l) => `+ ${l}`).join('\n') : '  (none)')
}

function expectGuard(oldLines: string[], expect: string | null): void {
  if (expect === null) return
  if (!oldLines.join('\n').includes(expect)) {
    fail(`--expect guard failed: the addressed lines do not contain ${JSON.stringify(expect)}. ` +
      'Line numbers are probably stale — re-run "show" and retry.')
  }
}

function contentLines(): string[] {
  const content = readStdin()
  if (content === '') return []
  const body = content.endsWith('\n') ? content.slice(0, -1) : content
  return body.split('\n')
}

function parseExpect(args: string[]): { rest: string[]; expect: string | null } {
  const index = args.indexOf('--expect')
  if (index === -1) return { rest: args, expect: null }
  const value = args[index + 1]
  if (value === undefined) fail('--expect requires a value')
  return { rest: [...args.slice(0, index), ...args.slice(index + 2)], expect: value }
}

function selfTest(): void {
  const dir = mkdtempSync(join(tmpdir(), 'edit-lines-test-'))
  const file = join(dir, 'sample.txt')
  const assert = (cond: boolean, msg: string): void => {
    if (!cond) {
      rmSync(dir, { recursive: true, force: true })
      fail(`self-test failed: ${msg}`)
    }
  }
  writeFileSync(file, 'one\ntwo\nthree\nfour\n', 'utf8')

  let f = readLines(file)
  assert(f.lines.length === 4 && f.trailingNewline, 'read shape')

  f.lines.splice(1, 2, 'TWO', 'TWO.5')
  writeLines(file, f)
  assert(readFileSync(file, 'utf8') === 'one\nTWO\nTWO.5\nfour\n', 'replace keeps neighbors + newline')

  f = readLines(file)
  f.lines.splice(4, 0, 'five')
  writeLines(file, f)
  assert(readFileSync(file, 'utf8') === 'one\nTWO\nTWO.5\nfour\nfive\n', 'insert at end')

  writeFileSync(file, 'no-trailing', 'utf8')
  f = readLines(file)
  assert(!f.trailingNewline && f.lines.length === 1, 'no-trailing detected')
  writeLines(file, f)
  assert(readFileSync(file, 'utf8') === 'no-trailing', 'no-trailing preserved')

  rmSync(dir, { recursive: true, force: true })
  console.log('edit-lines self-test: OK')
}

const argv = process.argv.slice(2)
if (argv[0] === '--self-test') {
  selfTest()
  process.exit(0)
}

const command = argv[0]
const { rest, expect } = parseExpect(argv.slice(1))

switch (command) {
  case 'show': {
    const [path, startRaw, endRaw] = rest
    if (!path || !startRaw || !endRaw) fail('usage: show <file> <start> <end>')
    const file = readLines(path)
    const start = Number(startRaw)
    const end = Math.min(Number(endRaw), file.lines.length)
    checkRange(file, start, end)
    console.log(numbered(file.lines.slice(start - 1, end), start))
    break
  }
  case 'replace': {
    const [path, startRaw, endRaw] = rest
    if (!path || !startRaw || !endRaw) fail('usage: replace <file> <start> <end> [--expect <substring>] < content')
    const file = readLines(path)
    const start = Number(startRaw)
    const end = Number(endRaw)
    checkRange(file, start, end)
    const oldLines = file.lines.slice(start - 1, end)
    expectGuard(oldLines, expect)
    const next = contentLines()
    file.lines.splice(start - 1, end - start + 1, ...next)
    writeLines(path, file)
    console.log(`edit-lines: replaced lines ${start}-${end} of ${path} (${oldLines.length} -> ${next.length} lines)`)
    printDiff(oldLines, start, next)
    break
  }
  case 'insert-after': {
    const [path, lineRaw] = rest
    if (!path || lineRaw === undefined) fail('usage: insert-after <file> <line> < content')
    const file = readLines(path)
    const line = Number(lineRaw)
    if (!Number.isInteger(line) || line < 0 || line > file.lines.length) {
      fail(`insert position must be 0..${file.lines.length} (got ${lineRaw})`)
    }
    const next = contentLines()
    if (next.length === 0) fail('no content on stdin')
    file.lines.splice(line, 0, ...next)
    writeLines(path, file)
    console.log(`edit-lines: inserted ${next.length} line(s) after line ${line} of ${path}`)
    printDiff([], line, next)
    break
  }
  case 'delete': {
    const [path, startRaw, endRaw] = rest
    if (!path || !startRaw || !endRaw) fail('usage: delete <file> <start> <end> [--expect <substring>]')
    const file = readLines(path)
    const start = Number(startRaw)
    const end = Number(endRaw)
    checkRange(file, start, end)
    const oldLines = file.lines.slice(start - 1, end)
    expectGuard(oldLines, expect)
    file.lines.splice(start - 1, end - start + 1)
    writeLines(path, file)
    console.log(`edit-lines: deleted lines ${start}-${end} of ${path}`)
    printDiff(oldLines, start, [])
    break
  }
  default:
    fail(`unknown command: ${command ?? '(none)'} — use show | replace | insert-after | delete | --self-test`)
}
