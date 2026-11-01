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
 * What one open rotary create/edit form is measured against (issue #1112).
 *
 * Turn/Polygon and Thread/Flutes are created and edited in the canvas side
 * panel, and their numbers describe the live bar. Those numbers are
 * meaningless on another bar, in another unit system, or in a replaced
 * document, so each panel compares this key with the one it opened against and
 * closes the form when the key changes (issue #1112 rt2-b carried the old
 * dialogs' rule over unchanged).
 *
 * The machine origin belongs in the key: a canned shape's stored frame and
 * placed mesh are stock coordinates, so moving the origin moves the physical
 * bar under a form filled against the old one. The setup identity and
 * orientation belong there for the same reason — a face switch is a setup
 * switch, and a rotated setup re-maps the bar's axes.
 *
 * One string, so React compares two contexts with `!==`.
 */

import { useEffect, useRef } from 'react'
import { isBarStock } from '../../types/barStock'
import { getStockBounds, type Project } from '../../types/project'
import { activeSetup } from '../../store/helpers/activeFace'
import { useProjectStore } from '../../store/projectStore'

/** The subset of the project the key reads; the store always has all of it. */
export type RotaryPanelContextProject = Pick<
  Project,
  'stock' | 'meta' | 'origin' | 'setups' | 'activeSetupId'
>

/**
 * Everything one create or edit request is measured against, as one string:
 * the document session (`projectKey` — incremented by new/load/open), the units,
 * the workflow type, the bar's shape/axis/size/box, the machine origin and the
 * active setup.
 */
export function rotaryPanelContextKey(
  project: RotaryPanelContextProject,
  projectKey: number,
): string {
  const stock = project.stock
  const bounds = getStockBounds(stock)
  const setup = activeSetup(project)
  return [
    `document:${projectKey}`,
    `units:${project.meta.units}`,
    `type:${project.meta.projectType ?? 'milling'}`,
    `shape:${stock.shape ?? 'block'}`,
    `axis:${isBarStock(stock) ? stock.axis : '-'}`,
    `thickness:${stock.thickness}`,
    `box:${bounds.minX},${bounds.maxX},${bounds.minY},${bounds.maxY}`,
    `origin:${project.origin.x},${project.origin.y},${project.origin.z}`,
    `setup:${setup.id}:${setup.kind ?? 'flat'}:${setup.orientation.axis}:${setup.orientation.angleDeg}`,
  ].join('|')
}

/**
 * Close the open form when the physical context behind it changes, for creation
 * and for editing alike. The first render only records the context the form
 * opened on; from then on any change drops it instead of leaving numbers
 * measured against a bar that is no longer there.
 */
export function useRotaryPanelContextClose(onClose: () => void): void {
  const project = useProjectStore((state) => state.project)
  const projectKey = useProjectStore((state) => state.projectKey)
  const context = rotaryPanelContextKey(project, projectKey)
  const lastContext = useRef(context)

  useEffect(() => {
    if (lastContext.current === context) return
    lastContext.current = context
    onClose()
  }, [context, onClose])
}
