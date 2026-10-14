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

export interface BuildPhase {
  name: string
  command: 'npm' | 'npx'
  args: string[]
}

/** The one ordered phase list behind `npm run build`; gates-only mode filters it, never copies it. */
export const BUILD_PHASES: readonly BuildPhase[] = [
  { name: 'docs:check', command: 'npm', args: ['run', 'docs:check'] },
  { name: 'lint', command: 'npm', args: ['run', 'lint'] },
  { name: 'check:e2e-lanes', command: 'npm', args: ['run', 'check:e2e-lanes'] },
  { name: 'check:colors', command: 'npm', args: ['run', 'check:colors'] },
  { name: 'check:portable-paths', command: 'npm', args: ['run', 'check:portable-paths'] },
  { name: 'check:i18n', command: 'npm', args: ['run', 'check:i18n'] },
  { name: 'sync-icons', command: 'npx', args: ['tsx', 'scripts/build-icon-sprite.ts'] },
  { name: 'typecheck', command: 'npx', args: ['tsc', '-b'] },
  { name: 'test', command: 'npm', args: ['test'] },
  { name: 'vite build', command: 'npx', args: ['vite', 'build'] },
]

export const SKIP_TESTS_FLAG = '--skip-tests'

/** Phases to run for the given CLI arguments: `--skip-tests` drops only the `test` phase (#985). */
export function selectBuildPhases(argv: readonly string[]): BuildPhase[] {
  const skipTests = argv.includes(SKIP_TESTS_FLAG)
  return BUILD_PHASES.filter((phase) => !(skipTests && phase.name === 'test'))
}
