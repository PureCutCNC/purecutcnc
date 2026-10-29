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
 * The Thread and Flutes entries (issues #1016 C1, #1112 slice F; canvas panel
 * in rt2-b).
 *
 * They are not a separate toolbar group: the creation drawer's rotary group
 * holds them next to the drawing shapes, and the tablet rail keeps a rail
 * variant. Each entry arms the canvas creation panel through the store — the
 * same page-level panel the other canned shapes use — so the drawer closing
 * cannot unmount an open form, and no modal is involved.
 *
 * The entries exist only while the workspace is on an active Around face with
 * a **round** bar: the unrolled sheet's raw coordinates describe a round bar, so
 * a square blank does not offer them (issue #1016 C2-U2).
 */

import { useProjectStore } from '../../../store/projectStore'
import { activeFace, aroundSketchAuthoringAvailable } from '../../../store/helpers/activeFace'
import { useI18n } from '../../../i18n/i18nContext'
import type { MessageKey } from '../../../i18n/locales/en'
import { Icon } from '../../Icon'
import { ToolbarActionButton } from './primitives'
import type { RotaryPatternCannedKind } from '../../../store/types'

interface RotaryCommand {
  kind: RotaryPatternCannedKind
  command: string
  icon: string
  labelKey: MessageKey
}

const ROTARY_COMMANDS: readonly RotaryCommand[] = [
  { kind: 'thread', command: 'rotary-thread', icon: 'surface', labelKey: 'dialogs.rotary.thread.button' },
  { kind: 'flutes', command: 'rotary-flutes', icon: 'tool-endmill', labelKey: 'dialogs.rotary.flutes.button' },
]

interface RotaryPatternActionsProps {
  variant?: 'drawer' | 'rail'
  tooltipSide?: 'bottom' | 'right'
}

function RotaryPatternActions({ variant = 'drawer', tooltipSide = 'bottom' }: RotaryPatternActionsProps) {
  const { t } = useI18n()
  const project = useProjectStore((state) => state.project)
  const start = useProjectStore((state) => state.startAddRotaryPatternPlacement)
  // Thread and Flutes are round-only sheet authoring (issue #1016 C2-U2): the
  // unrolled sheet's raw coordinates describe a round bar, so on a square blank
  // the entries are absent rather than offered and refused.
  if (activeFace(project) !== 'around' || !aroundSketchAuthoringAvailable(project)) return null

  if (variant === 'rail') {
    return (
      <>
        {ROTARY_COMMANDS.map((entry) => {
          const label = t(entry.labelKey)
          return (
            <div className="tool-rail__action" key={entry.kind}>
              <button
                className="tool-rail__btn"
                type="button"
                data-command={entry.command}
                aria-label={label}
                onClick={() => start(entry.kind)}
              >
                <Icon id={entry.icon} />
              </button>
              <span className="tool-rail__tooltip" role="tooltip">{label}</span>
            </div>
          )
        })}
      </>
    )
  }

  // The drawer stacks its shape rows; the rotary group is one row behind a
  // separator owned by `CreationActions`, so Thread and Flutes sit in the same
  // group as Turn and Polygon (issue #1112 decision 4).
  return (
    <>
      {ROTARY_COMMANDS.map((entry) => (
        <ToolbarActionButton
          key={entry.kind}
          icon={entry.icon}
          label={t(entry.labelKey)}
          command={entry.command}
          tooltipSide={tooltipSide}
          onClick={() => start(entry.kind)}
        />
      ))}
    </>
  )
}

export { RotaryPatternActions }
