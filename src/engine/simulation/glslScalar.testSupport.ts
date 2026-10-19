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
 * Test support: run scalar GLSL functions in Node.
 *
 * The step/slope rule, the lighting gradient and the Around cell wrap live in
 * GLSL, where a unit test cannot reach them. A TypeScript copy would only prove
 * the copy, so the shader source keeps those functions to a scalar subset —
 * `float`/`bool`/`int`/`ivec2` parameters and locals, arithmetic, comparisons,
 * `if`, the ternary, and the builtins listed below — which reads as JavaScript
 * once the type names are dropped. An `ivec2` is a plain `{ x, y }` object, so
 * a GLSL function that wraps one index and leaves the other alone can be run
 * and checked directly. Uniforms the function reads are passed as `globals`
 * (issue #395 G3). The tests then call the very text the GPU compiles, for
 * those functions.
 *
 * That is all it covers. The vector code around them — texture lookups, which
 * cell feeds which argument, the final normal — cannot run here and is covered
 * by the rendered e2e tests instead.
 *
 * Numbers are doubles here and 32-bit floats on the GPU, so tests should stay
 * clear of cases that depend on the last bit.
 */

/** An `ivec2` is a `{ x, y }`; everything else is a GLSL scalar. */
export type ScalarValue = number | boolean | { x: number; y: number }
type ScalarFunction = (...args: ScalarValue[]) => ScalarValue

const BUILTINS = {
  abs: Math.abs,
  sin: Math.sin,
  cos: Math.cos,
  sqrt: Math.sqrt,
  min: Math.min,
  max: Math.max,
  mix: (a: number, b: number, t: number): number => a * (1 - t) + b * t,
  clamp: (x: number, low: number, high: number): number => Math.min(Math.max(x, low), high),
  ceil: Math.ceil,
  // GLSL int() truncates toward zero, exactly as Math.trunc does.
  int: Math.trunc,
}

const TYPE = '(?:float|bool|int|ivec2)'

/**
 * Compile every function in `source` and return them by name. `globals` are
 * bound as uniform-like values the functions may read. Throws when the source
 * uses something outside the subset, so a shader edit that leaves it is a
 * failing test rather than a silently skipped one.
 */
export function compileScalarGlsl(
  source: string,
  globals: Record<string, number | boolean> = {},
): Record<string, ScalarFunction> {
  const names: string[] = []
  const withFunctions = source.replace(
    new RegExp(`\\b${TYPE}\\s+(\\w+)\\s*\\(([^)]*)\\)\\s*\\{`, 'g'),
    (_match, name: string, parameters: string) => {
      names.push(name)
      const parameterNames = parameters
        .split(',')
        .map((parameter) => parameter.trim())
        .filter((parameter) => parameter.length > 0)
        .map((parameter) => {
          const declared = new RegExp(`^${TYPE}\\s+(\\w+)$`).exec(parameter)
          if (!declared) throw new Error(`compileScalarGlsl: unsupported parameter "${parameter}" in ${name}`)
          return declared[1]
        })
      return `function ${name}(${parameterNames.join(', ')}) {`
    },
  )
  const script = withFunctions.replace(new RegExp(`\\b${TYPE}\\s+(\\w+)\\s*=`, 'g'), 'let $1 =')

  // `int`/`ivec2` are supported here (`int(x)` is a builtin, an `ivec2` is an
  // object); every other vector/matrix type is not.
  const leftover = /\b(?:float|bool|uniform|sampler2D|texelFetch|ivec[34]|vec[234]|uvec[234]|bvec[234]|mat[234])\b/.exec(script)
  if (leftover) {
    throw new Error(`compileScalarGlsl: "${leftover[0]}" is outside the scalar subset`)
  }
  if (names.length === 0) throw new Error('compileScalarGlsl: no functions found')

  const globalNames = Object.keys(globals)
  const builtinNames = Object.keys(BUILTINS)
  const factory = new Function(...builtinNames, ...globalNames, `'use strict';\n${script}\nreturn { ${names.join(', ')} };`) as (
    ...args: unknown[]
  ) => Record<string, ScalarFunction>
  return factory(...Object.values(BUILTINS), ...globalNames.map((name) => globals[name]))
}
