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

// Keep-improving search for a nest (issue #862, step 6 of #741): a small
// genetic search over the order copies are placed in. Rotation stays the
// placer's greedy choice per copy. The population is seeded with the one-shot
// order, so the first result is the one-shot answer and the best can only get
// better from there. A seeded RNG makes every run reproducible.

import { createNester } from './packer'
import type { NestRequest, NestResult } from './types'

export interface ImproveOptions {
  seed?: number
  /** Layouts per generation, the elite included. */
  populationSize?: number
  /** Chance per position of swapping a copy with its neighbour. */
  mutationRate?: number
  /** Stop after this many layouts in a row without an improvement. */
  stallLimit?: number
}

export interface ImproveStep {
  /** Layouts placed so far, the first answer included. */
  evaluated: number
  /** The best layout so far; the first step's is the one-shot answer. */
  best: NestResult
  /** True when this layout became the new best. */
  improved: boolean
}

export const DEFAULT_IMPROVE_OPTIONS: Required<ImproveOptions> = {
  seed: 1,
  populationSize: 10,
  mutationRate: 0.1,
  stallLimit: 150,
}

/** Fewer unplaced parts first, then a smaller used area. Relative tolerance keeps float noise out. */
export function isBetterNest(candidate: NestResult, incumbent: NestResult): boolean {
  const unplacedSlack = 1e-9 * Math.max(1, incumbent.unplacedArea)
  if (candidate.unplacedArea < incumbent.unplacedArea - unplacedSlack) return true
  if (candidate.unplacedArea > incumbent.unplacedArea + unplacedSlack) return false
  return candidate.usedArea < incumbent.usedArea * (1 - 1e-9)
}

/** Mulberry32: small, fast and good enough to shuffle an order reproducibly. */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Individual {
  /** A permutation of positions in the initial sequence. */
  order: number[]
  result: NestResult
}

/**
 * Yields once per layout placed, starting with the one-shot answer, and returns
 * once `stallLimit` layouts in a row brought no improvement. The caller stops
 * earlier simply by not asking for the next step.
 */
export function* improveNest(request: NestRequest, options: ImproveOptions = {}): Generator<ImproveStep, void, void> {
  const { seed, populationSize, mutationRate, stallLimit } = { ...DEFAULT_IMPROVE_OPTIONS, ...options }
  const nester = createNester(request)
  const initial = nester.initialSequence
  const rng = random(seed)
  const size = Math.max(2, populationSize)

  let evaluated = 0
  let sinceImprovement = 0
  let best: Individual | null = null
  const evaluate = (order: number[]): { individual: Individual; step: ImproveStep } => {
    const result = nester.place(order.map((position) => initial[position]))
    evaluated += 1
    const individual = { order, result }
    const improved = best !== null && isBetterNest(result, best.result)
    if (best === null || improved) {
      best = individual
      sinceImprovement = 0
    } else {
      sinceImprovement += 1
    }
    return { individual, step: { evaluated, best: best.result, improved } }
  }

  const identity = initial.map((_, index) => index)
  // Nothing to reorder: the one-shot answer is the only layout.
  if (initial.length < 2) {
    yield evaluate(identity).step
    return
  }

  const mutate = (order: number[]): number[] => {
    const next = [...order]
    for (let index = 0; index < next.length - 1; index += 1) {
      if (rng() < mutationRate) [next[index], next[index + 1]] = [next[index + 1], next[index]]
    }
    // Always change something, or a copy of the parent is evaluated again.
    if (next.every((value, index) => value === order[index])) {
      const index = Math.floor(rng() * (next.length - 1))
      ;[next[index], next[index + 1]] = [next[index + 1], next[index]]
    }
    return next
  }

  // Order crossover: a slice of one parent, the rest in the other's order.
  const crossover = (first: number[], second: number[]): number[] => {
    const a = Math.floor(rng() * first.length)
    const b = a + Math.floor(rng() * (first.length - a)) + 1
    const slice = first.slice(a, b)
    const taken = new Set(slice)
    const rest = second.filter((value) => !taken.has(value))
    return [...rest.slice(0, a), ...slice, ...rest.slice(a)]
  }

  let population: Individual[] = []
  for (const order of [identity, ...Array.from({ length: size - 1 }, () => mutate(identity))]) {
    const { individual, step } = evaluate(order)
    population.push(individual)
    yield step
    if (sinceImprovement >= stallLimit) return
  }

  const pick = (): Individual => {
    const a = population[Math.floor(rng() * population.length)]
    const b = population[Math.floor(rng() * population.length)]
    return isBetterNest(b.result, a.result) ? b : a
  }

  for (;;) {
    const next: Individual[] = [best!]
    while (next.length < size) {
      const { individual, step } = evaluate(mutate(crossover(pick().order, pick().order)))
      next.push(individual)
      yield step
      if (sinceImprovement >= stallLimit) return
    }
    population = next
  }
}
