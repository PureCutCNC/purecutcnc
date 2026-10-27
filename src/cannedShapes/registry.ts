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

import type { RegisteredCannedShapeGenerator } from './types'
import { BUILT_IN_CANNED_SHAPES } from './generators'

/**
 * Canned-shape generator registry (issue #1112).
 *
 * Built-ins are listed in `./generators`, which imports only the generator
 * type — never this module — so seeding the map cannot cycle back through a
 * module that is still evaluating. Tests register their own via
 * {@link registerCannedShapeGenerator}.
 */
const generators = new Map<string, RegisteredCannedShapeGenerator>(
  BUILT_IN_CANNED_SHAPES.map((generator) => [generator.kind, generator]),
)

const editors = new Map<string, (featureId: string) => void>()

/** Register (or replace) the generator for one shape kind. */
export function registerCannedShapeGenerator(generator: RegisteredCannedShapeGenerator): void {
  generators.set(generator.kind, generator)
}

/** The generator for `kind`, or `null` when no build part has registered it. */
export function getCannedShapeGenerator(kind: string): RegisteredCannedShapeGenerator | null {
  return generators.get(kind) ?? null
}

/**
 * Register the dialog opener for one shape kind. The Properties button stays
 * disabled until a slice supplies one, so slice A ships the button without
 * shipping a dialog for a shape that does not exist yet.
 */
export function registerCannedShapeEditor(kind: string, editor: (featureId: string) => void): void {
  editors.set(kind, editor)
}

/** The dialog opener for `kind`, or `null` when no slice has wired it yet. */
export function getCannedShapeEditor(kind: string): ((featureId: string) => void) | null {
  return editors.get(kind) ?? null
}
