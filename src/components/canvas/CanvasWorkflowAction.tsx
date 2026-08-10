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

import { Icon } from '../Icon'
import { CANVAS_SHORTCUT, withShortcut } from './canvasShortcuts'
import type { CanvasShortcut } from './canvasShortcuts'

interface CanvasWorkflowActionProps {
  /** Translated label. Also the accessible name when the button is icon-only. */
  label: string
  onClick: () => void
  /** Sprite icon id. Given → icon-only button; omitted → text button. */
  icon?: string
  shortcut?: CanvasShortcut
  variant?: 'confirm' | 'cancel' | 'neutral'
  disabled?: boolean
}

/**
 * One action button in a canvas workflow panel's title bar.
 *
 * A text button shows its shortcut inline — `Dimensions (Tab)`. An icon-only
 * button has no text to append to, so the shortcut goes into its accessible
 * name and tooltip instead — `Cancel (Esc)`. Either way the key is stated once
 * and comes from the same constant the handler is named by.
 */
export function CanvasWorkflowAction({
  label,
  onClick,
  icon,
  shortcut,
  variant = 'neutral',
  disabled = false,
}: CanvasWorkflowActionProps) {
  const hinted = shortcut ? withShortcut(label, shortcut) : label
  const className = [
    'tablet-cmd-btn',
    variant === 'confirm' ? 'tablet-cmd-btn--confirm' : '',
    variant === 'cancel' ? 'tablet-cmd-btn--cancel' : '',
    icon ? 'tablet-cmd-btn--icon' : '',
  ].filter(Boolean).join(' ')
  // An action with a key mapped to it does not also need to be a tab stop — Tab is
  // then free to cycle only the panel's input fields. An action WITHOUT a key has no
  // other keyboard route, so it stays in the tab order. Either way the button keeps
  // its accessible name and stays reachable by screen-reader navigation and pointer.
  const tabIndex = shortcut ? -1 : 0

  if (icon) {
    return (
      <button
        type="button"
        className={className}
        onClick={onClick}
        disabled={disabled}
        tabIndex={tabIndex}
        // The key belongs in aria-keyshortcuts, not in the accessible name: baking
        // it into the label makes a screen reader read "Cancel Esc" on every focus,
        // and it silently rewrites the name every consumer matches this button by.
        aria-keyshortcuts={shortcut}
        aria-label={label}
        title={hinted}
      >
        <Icon id={icon} size={18} />
      </button>
    )
  }

  return (
    <button
      type="button"
      className={className}
      onClick={onClick}
      disabled={disabled}
      tabIndex={tabIndex}
      aria-keyshortcuts={shortcut}
    >
      {hinted}
    </button>
  )
}

interface StandardActionProps {
  label: string
  onClick: () => void
  disabled?: boolean
}

/**
 * Every panel dismisses on Esc and shows the same ✕, so that pairing is defined
 * once here rather than restated at a dozen call sites.
 */
export function CanvasWorkflowCancel({ label, onClick, disabled }: StandardActionProps) {
  return (
    <CanvasWorkflowAction
      variant="cancel"
      icon="close"
      shortcut={CANVAS_SHORTCUT.cancel}
      label={label}
      onClick={onClick}
      disabled={disabled}
    />
  )
}

/** The Enter/✓ counterpart to {@link CanvasWorkflowCancel}. */
export function CanvasWorkflowConfirm({ label, onClick, disabled }: StandardActionProps) {
  return (
    <CanvasWorkflowAction
      variant="confirm"
      icon="check"
      shortcut={CANVAS_SHORTCUT.confirm}
      label={label}
      onClick={onClick}
      disabled={disabled}
    />
  )
}
