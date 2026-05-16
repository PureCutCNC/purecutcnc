import type { HTMLAttributes, ReactNode, RefObject } from 'react'
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
  moveLabel = 'Move workflow controls',
}: CanvasWorkflowPanelProps) {
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
        aria-label={moveLabel}
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
