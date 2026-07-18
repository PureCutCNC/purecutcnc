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

import type { HTMLAttributes, ReactNode, RefObject } from 'react'
import { useI18n } from '../../i18n/i18nContext'
import type { CanvasWorkflowPanelPosition } from './useCanvasWorkflowPanel'

interface CanvasWorkflowPanelProps {
  title: string
  step?: ReactNode
  children: ReactNode
  actions: ReactNode
  position: CanvasWorkflowPanelPosition
  panelRef: RefObject<HTMLDivElement | null>
  handleProps: HTMLAttributes<HTMLDivElement>
  actionRowProps?: HTMLAttributes<HTMLDivElement>
  className?: string
  moveLabel?: string
}

export function CanvasWorkflowPanel({
  title,
  step,
  children,
  actions,
  position,
  panelRef,
  handleProps,
  actionRowProps,
  className = '',
  moveLabel,
}: CanvasWorkflowPanelProps) {
  const { t } = useI18n()
  const resolvedMoveLabel = moveLabel ?? t('canvas.common.moveControls')
  const panelClassName = ['canvas-workflow-panel', className].filter(Boolean).join(' ')

  return (
    <div
      ref={panelRef}
      className={panelClassName}
      style={{ left: position.x, top: position.y }}
    >
      <div
        className="canvas-workflow-panel__handle"
        role="button"
        tabIndex={0}
        aria-label={resolvedMoveLabel}
        {...handleProps}
      >
        <span className="canvas-workflow-panel__grip" aria-hidden="true" />
        <span className="canvas-workflow-panel__title">{title}</span>
      </div>
      <div className="canvas-workflow-panel__body">
        {step ? <div className="canvas-workflow-panel__step">{step}</div> : null}
        {children}
      </div>
      <div className="canvas-workflow-panel__actions" {...actionRowProps}>
        {actions}
      </div>
    </div>
  )
}
