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

import { useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../Icon'
import { usePortalPosition } from '../../hooks/usePortalPosition'
import { useOutsideDismiss } from '../../hooks/useOutsideDismiss'
import { useProjectStore } from '../../store/projectStore'
import { activeFace, aroundSketchAuthoringRefused } from '../../store/helpers/activeFace'
import { TextToolDialog } from '../project/TextToolDialog'
import type { TextToolConfig } from '../../text'
import { useCreationShapeCommands, type CreationShape } from '../../commands/creationShapes'
import { useSketchCommands } from '../../commands/sketchCommands'
import { useI18n } from '../../i18n/i18nContext'
import type { MessageKey } from '../../i18n/locales/en'
import type { CreationTarget } from '../../store/types'
import { RotaryPatternActions } from './toolbar/RotaryPatternActions'
import { RotarySolidActions } from './toolbar/RotarySolidActions'

function RailButton({
  icon,
  label,
  active = false,
  emphasized = false,
  disabled = false,
  disabledReason,
  onClick,
}: {
  icon: string
  label: string
  active?: boolean
  emphasized?: boolean
  disabled?: boolean
  disabledReason?: string
  onClick: () => void
}) {
  return (
    <div className="tool-rail__action">
      <button
        className={`tool-rail__btn ${active ? 'tool-rail__btn--active' : ''} ${emphasized ? 'tool-rail__btn--live' : ''}`}
        type="button"
        aria-label={label}
        disabled={disabled}
        title={disabled && disabledReason ? disabledReason : undefined}
        onClick={(e) => {
          onClick()
          e.currentTarget.blur()
        }}
      >
        <Icon id={icon} />
      </button>
      <span className="tool-rail__tooltip" role="tooltip">
        {disabled && disabledReason ? `${label} — ${disabledReason}` : label}
      </span>
    </div>
  )
}

/**
 * A rail button with a flyout menu (align / distribute). The menu is portaled
 * to document.body and positioned with fixed coordinates from the trigger, so
 * the scrolling tool rail (overflow-y: auto) cannot clip it.
 */
function RailFlyout({
  icon,
  label,
  tooltip,
  open,
  onToggle,
  onClose,
  children,
}: {
  icon: string
  label: string
  tooltip: string
  open: boolean
  onToggle: () => void
  onClose: () => void
  children: ReactNode
}) {
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const popRef = useRef<HTMLDivElement | null>(null)
  const coords = usePortalPosition(btnRef, popRef, open, (b, p) => {
    const margin = 8
    let left = b.right + 6
    let top = b.top + b.height / 2 - p.height / 2
    left = Math.max(margin, Math.min(left, window.innerWidth - p.width - margin))
    top = Math.max(margin, Math.min(top, window.innerHeight - p.height - margin))
    return { top, left }
  })

  useOutsideDismiss({ open, refs: [btnRef, popRef], onDismiss: onClose })

  return (
    <div className="tool-rail__action">
      <button
        ref={btnRef}
        className={`tool-rail__btn ${open ? 'tool-rail__btn--active' : ''}`}
        type="button"
        aria-label={label}
        onClick={onToggle}
      >
        <Icon id={icon} />
      </button>
      <span className="tool-rail__tooltip" role="tooltip">{tooltip}</span>
      {open
        ? createPortal(
            <div
              ref={popRef}
              className="tool-rail__popover tool-rail__popover--floating"
              style={{
                position: 'fixed',
                top: coords?.top ?? -9999,
                left: coords?.left ?? -9999,
                visibility: coords ? 'visible' : 'hidden',
              }}
            >
              {children}
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}

interface ToolRailProps {
  onZoomToModel: () => void
  onImportComplete?: () => void
}

export function ToolRail({ onZoomToModel: _onZoomToModel, onImportComplete: _onImportComplete }: ToolRailProps) {
  void _onZoomToModel
  void _onImportComplete

  const [showTextDialog, setShowTextDialog] = useState(false)
  const [showCreationPopover, setShowCreationPopover] = useState(false)
  const [showAlignPopover, setShowAlignPopover] = useState(false)
  const [showDistributePopover, setShowDistributePopover] = useState(false)
  const [lastCreationShape, setLastCreationShape] = useState<CreationShape>('rect')
  const { t } = useI18n()
  const project = useProjectStore((state) => state.project)
  // On a square blank's Around sheet the sheet is round-only, so the drawing
  // rail is hidden there. The desktop creation block keeps the same entries
  // listed and disabled with the reason (issue #1112 decision 17); the rail is
  // left as #1016 C2-U1/U2 built it.
  const sketchAuthoringRefused = aroundSketchAuthoringRefused(project, activeFace(project))
  const aroundFace = activeFace(project) === 'around'
  const sketchCommands = useSketchCommands()
  const cannedRefusal = sketchCommands.predicates.hasCannedSelectedFeatures
    ? t('sketch.canned.actionRefused')
    : undefined
  // A rotary canned shape refuses the three transforms, and its Resize names
  // its own editor — the same reasons the context menu shows (issue #1112
  // rt7-f). The rail is a third door onto the same commands.
  const rotaryTransformRefusal = sketchCommands.predicates.hasRotaryCannedSelectedFeatures
    ? t('sketch.canned.actionRefused')
    : undefined
  const rotaryResizeRefusal = sketchCommands.predicates.rotaryCannedShapeLabelKey
    ? t('featureTree.contextMenu.resizeCannedTooltip', {
        edit: t('featureTree.properties.canned.edit', {
          shape: t(sketchCommands.predicates.rotaryCannedShapeLabelKey as MessageKey),
        }),
      })
    : rotaryTransformRefusal
  const creationCommands = useCreationShapeCommands({
    onRequestText: () => setShowTextDialog(true),
  })

  const TARGET_NOUN_KEYS: Record<CreationTarget, MessageKey> = {
    feature: 'sketch.target.feature',
    line: 'sketch.target.line',
    region: 'sketch.target.region',
    construction: 'sketch.target.construction',
  }
  const targetNoun = t(TARGET_NOUN_KEYS[creationCommands.creationTarget])
  const availableCreationOptions = creationCommands.availableShapeCommands
  const lastCreationOption = availableCreationOptions.find((option) => option.id === lastCreationShape) ?? availableCreationOptions[0]

  function selectCreationShape(shape: CreationShape) {
    setLastCreationShape(shape)
    setShowCreationPopover(false)
    creationCommands.activateShape(shape)
  }

  function confirmTextTool(config: TextToolConfig) {
    creationCommands.confirmTextTool(config)
    setShowTextDialog(false)
  }

  function handleAlign(alignment: Parameters<typeof sketchCommands.arrange.alignFeature>[0]) {
    sketchCommands.arrange.alignFeature(alignment)
    setShowAlignPopover(false)
  }

  function handleDistribute(distribution: Parameters<typeof sketchCommands.arrange.distributeFeatures>[0]) {
    sketchCommands.arrange.distributeFeatures(distribution)
    setShowDistributePopover(false)
  }

  function startNest() {
    sketchCommands.arrange.startNest()
    setShowDistributePopover(false)
  }

  function startTextLayout() {
    sketchCommands.arrange.startTextLayout()
    setShowDistributePopover(false)
  }

  function startFeatureDistribution(mode: Parameters<typeof sketchCommands.arrange.startFeatureDistribution>[0]) {
    sketchCommands.arrange.startFeatureDistribution(mode)
    setShowDistributePopover(false)
  }

  return (
    <>
      <nav className="tool-rail" aria-label={t('appShell.drawer.tools')}>
        {/* Creation target toggle */}
        {sketchAuthoringRefused ? null : (
        <>
        <div className="tool-rail__section">
          <div className="tool-rail__target-toggle">
            <button
              className={`tool-rail__target-btn ${creationCommands.creationTarget === 'feature' ? 'tool-rail__target-btn--active' : ''}`}
              type="button"
              aria-label={t('sketch.target.createFeatures')}
              aria-pressed={creationCommands.creationTarget === 'feature'}
              onClick={() => creationCommands.setCreationTarget('feature')}
            >
              <Icon id="plus" />
            </button>
            <button
              className={`tool-rail__target-btn tool-rail__target-btn--line ${creationCommands.creationTarget === 'line' ? 'tool-rail__target-btn--active' : ''}`}
              type="button"
              aria-label={t('sketch.target.createLines')}
              aria-pressed={creationCommands.creationTarget === 'line'}
              onClick={() => creationCommands.setCreationTarget('line')}
            >
              <Icon id="snap-line" />
            </button>
            <button
              className={`tool-rail__target-btn tool-rail__target-btn--region ${creationCommands.creationTarget === 'region' ? 'tool-rail__target-btn--active' : ''}`}
              type="button"
              aria-label={t('sketch.target.createRegions')}
              aria-pressed={creationCommands.creationTarget === 'region'}
              onClick={() => creationCommands.setCreationTarget('region')}
            >
              <Icon id="pocket" />
            </button>
            <button
              className={`tool-rail__target-btn tool-rail__target-btn--construction ${creationCommands.creationTarget === 'construction' ? 'tool-rail__target-btn--active' : ''}`}
              type="button"
              aria-label={t('sketch.target.createConstruction')}
              aria-pressed={creationCommands.creationTarget === 'construction'}
              onClick={() => creationCommands.setCreationTarget('construction')}
            >
              <Icon id="construction" />
            </button>
          </div>
        </div>

        {/* Creation tools */}
        <div className="tool-rail__section">
          <RailFlyout
            icon="feature-drawer"
            label={t('sketch.creation.chooseTarget', { target: targetNoun })}
            tooltip={t('appShell.toolRail.shapes')}
            open={showCreationPopover}
            onToggle={() => {
              setShowCreationPopover((v) => !v)
              setShowAlignPopover(false)
              setShowDistributePopover(false)
            }}
            onClose={() => setShowCreationPopover(false)}
          >
            {availableCreationOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                aria-label={option.label}
                className={lastCreationOption.id === option.id ? 'tool-rail__popover-btn--active' : ''}
                onClick={() => selectCreationShape(option.id)}
              >
                <Icon id={option.icon} />
              </button>
            ))}
          </RailFlyout>
          <RailButton
            icon={lastCreationOption.icon}
            label={lastCreationOption.label}
            active={lastCreationOption.active}
            onClick={lastCreationOption.onActivate}
          />
        </div>
        </>
        )}

        {/* Turn and Polygon, and on a round bar Thread and Flutes. The solid
            entries work on either bar shape; Thread and Flutes self-guard on a
            round bar. The group renders only on Around, so no empty rail
            section is left behind on a flat face. */}
        {aroundFace && (
          <div className="tool-rail__section">
            <RotarySolidActions variant="rail" />
            <RotaryPatternActions variant="rail" />
          </div>
        )}

        {/* Edit tools (visible when features selected) */}
        {sketchCommands.predicates.hasSelectedFeatures && (
          <div className="tool-rail__section">
            <RailButton icon="copy" label={t('appShell.toolRail.copy')} active={sketchCommands.transform.copy.active} onClick={sketchCommands.transform.copy.onActivate} />
            <RailButton icon="move" label={t('appShell.toolRail.move')} active={sketchCommands.transform.move.active} disabled={!sketchCommands.transform.move.enabled} onClick={sketchCommands.transform.move.onActivate} />
            <RailButton icon="trash" label={t('appShell.toolRail.delete')} onClick={sketchCommands.transform.delete.onActivate} />
            <RailButton icon="resize" label={t('appShell.toolRail.resize')} active={sketchCommands.transform.resize.active} disabled={!sketchCommands.transform.resize.enabled} disabledReason={rotaryResizeRefusal} onClick={sketchCommands.transform.resize.onActivate} />
            <RailButton icon="rotate" label={t('appShell.toolRail.rotate')} active={sketchCommands.transform.rotate.active} disabled={!sketchCommands.transform.rotate.enabled} disabledReason={rotaryTransformRefusal} onClick={sketchCommands.transform.rotate.onActivate} />
            <RailButton icon="mirror" label={t('appShell.toolRail.mirror')} active={sketchCommands.transform.mirror.active} disabled={!sketchCommands.transform.mirror.enabled} disabledReason={rotaryTransformRefusal} onClick={sketchCommands.transform.mirror.onActivate} />
            <RailButton icon="offset" label={t('appShell.toolRail.offset')} active={sketchCommands.boolean.offset.active} disabled={!sketchCommands.boolean.offset.enabled} disabledReason={cannedRefusal} onClick={sketchCommands.boolean.offset.onActivate} />
            <RailButton icon="constraint" label={t('appShell.toolRail.constraint')} active={sketchCommands.constraint.active} disabled={!sketchCommands.constraint.enabled} disabledReason={cannedRefusal} onClick={sketchCommands.constraint.onActivate} />
            <RailButton icon="merge" label={t('appShell.toolRail.join')} active={sketchCommands.boolean.join.active} disabled={!sketchCommands.boolean.join.enabled} disabledReason={cannedRefusal} onClick={sketchCommands.boolean.join.onActivate} />
            <RailButton icon="cut" label={t('appShell.toolRail.cut')} active={sketchCommands.boolean.cut.active} disabled={!sketchCommands.boolean.cut.enabled} disabledReason={cannedRefusal} onClick={sketchCommands.boolean.cut.onActivate} />
          </div>
        )}

        {/* Alignment and pattern distribution */}
        {sketchCommands.predicates.hasSelectedFeatures && (
          <div className="tool-rail__section">
            {sketchCommands.predicates.canAlignSelectedFeatures && (
              <RailFlyout
                icon="align"
                label={t('sketch.arrange.align')}
                tooltip={t('appShell.toolRail.align')}
                open={showAlignPopover}
                onToggle={() => { setShowAlignPopover((v) => !v); setShowDistributePopover(false) }}
                onClose={() => setShowAlignPopover(false)}
              >
                <button type="button" aria-label={t('sketch.align.left')} onClick={() => handleAlign('left')}><Icon id="align-left" /></button>
                <button type="button" aria-label={t('sketch.align.centerHorizontal')} onClick={() => handleAlign('center_horizontal')}><Icon id="align-center-horizontal" /></button>
                <button type="button" aria-label={t('sketch.align.right')} onClick={() => handleAlign('right')}><Icon id="align-right" /></button>
                <button type="button" aria-label={t('sketch.align.top')} onClick={() => handleAlign('top')}><Icon id="align-top" /></button>
                <button type="button" aria-label={t('sketch.align.centerVertical')} onClick={() => handleAlign('center_vertical')}><Icon id="align-center-vertical" /></button>
                <button type="button" aria-label={t('sketch.align.bottom')} onClick={() => handleAlign('bottom')}><Icon id="align-bottom" /></button>
              </RailFlyout>
            )}
            <RailFlyout
              icon="distribute"
              label={t('sketch.arrange.distribute')}
              tooltip={t('appShell.toolRail.distribute')}
              open={showDistributePopover}
              onToggle={() => { setShowDistributePopover((v) => !v); setShowAlignPopover(false) }}
              onClose={() => setShowDistributePopover(false)}
            >
              <button type="button" aria-label={t('sketch.distribute.horizontalGaps')} disabled={!sketchCommands.predicates.canDistributeSelectedFeatures} onClick={() => handleDistribute('horizontal_gaps')}><Icon id="distribute-horizontal-gaps" /></button>
              <button type="button" aria-label={t('sketch.distribute.horizontalCenters')} disabled={!sketchCommands.predicates.canDistributeSelectedFeatures} onClick={() => handleDistribute('horizontal_centers')}><Icon id="distribute-horizontal-centers" /></button>
              <button type="button" aria-label={t('sketch.distribute.verticalGaps')} disabled={!sketchCommands.predicates.canDistributeSelectedFeatures} onClick={() => handleDistribute('vertical_gaps')}><Icon id="distribute-vertical-gaps" /></button>
              <button type="button" aria-label={t('sketch.distribute.verticalCenters')} disabled={!sketchCommands.predicates.canDistributeSelectedFeatures} onClick={() => handleDistribute('vertical_centers')}><Icon id="distribute-vertical-centers" /></button>
              <button type="button" aria-label={t('canvas.featureDistribution.grid')} disabled={!sketchCommands.predicates.canCreateFeatureDistribution} onClick={() => startFeatureDistribution('grid')}><Icon id="grid" /></button>
              <button type="button" aria-label={t('canvas.featureDistribution.radial')} disabled={!sketchCommands.predicates.canCreateFeatureDistribution} onClick={() => startFeatureDistribution('radial')}><Icon id="rotate" /></button>
              <button type="button" aria-label={t('canvas.featureDistribution.path')} disabled={!sketchCommands.predicates.canCreateFeatureDistribution} onClick={() => startFeatureDistribution('path')}><Icon id="spline" /></button>
              <button type="button" aria-label={t('canvas.textLayout.title')} disabled={!sketchCommands.predicates.canLayOutText} onClick={() => startTextLayout()}><Icon id="text" /></button>
              <button type="button" aria-label={t('canvas.nest.title')} disabled={!sketchCommands.predicates.canNest} onClick={() => startNest()}><Icon id="nest" /></button>
            </RailFlyout>
          </div>
        )}
      </nav>

      {showTextDialog && typeof document !== 'undefined'
        ? createPortal(
            <TextToolDialog onClose={() => setShowTextDialog(false)} onConfirm={confirmTextTool} />,
            document.body,
          )
        : null}
    </>
  )
}
