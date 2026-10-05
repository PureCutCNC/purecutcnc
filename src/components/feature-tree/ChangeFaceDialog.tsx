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

import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useI18n } from '../../i18n/i18nContext'
import { useFaceViewStore } from '../../store/faceViewStore'
import { flippedZRange, linkedCopiesOffFace, resolveStockSpan } from '../../store/helpers/activeFace'
import { useProjectStore } from '../../store/projectStore'
import type { FeatureInstance, Project, SetupFace } from '../../types/project'
import { formatLength } from '../../utils/units'
import { useRestoreCanvasFocus } from '../../utils/useRestoreCanvasFocus'
import { FaceChip } from './FaceChip'

const LISTED_FEATURES = 6

function oppositeFace(face: SetupFace): SetupFace {
  return face === 'top' ? 'bottom' : 'top'
}

/**
 * A feature's Z range as its face shows it, top → bottom like the canvas
 * label: the stored span on Top, the stock flipped on Bottom.
 */
function formatZRange(project: Project, feature: FeatureInstance, face: SetupFace): string {
  const span = resolveStockSpan(project, feature)
  if (!span) return '—'
  const range = face === 'bottom' ? flippedZRange(span, project.stock) : { top: span.z_top, bottom: span.z_bottom }
  return `${formatLength(range.top, project.meta.units)} → ${formatLength(range.bottom, project.meta.units)}`
}

function formatSpan(project: Project, feature: FeatureInstance): string {
  const span = resolveStockSpan(project, feature)
  if (!span) return '—'
  return `${formatLength(span.z_top, project.meta.units)} → ${formatLength(span.z_bottom, project.meta.units)}`
}

/**
 * The confirmation every authoring-face change goes through (issue #945).
 * It shows what changes — the face a feature is drawn on, and so how its Z
 * range reads — and what does not: its place in the stock.
 */
export function ChangeFaceDialog() {
  const request = useFaceViewStore((state) => state.faceChangeRequest)
  return request ? <ChangeFaceDialogBody featureIds={request} /> : null
}

function ChangeFaceDialogBody({ featureIds }: { featureIds: readonly string[] }) {
  useRestoreCanvasFocus()
  const { t } = useI18n()
  const project = useProjectStore((state) => state.project)
  const setFeatureAuthoringFace = useProjectStore((state) => state.setFeatureAuthoringFace)
  const close = useFaceViewStore((state) => state.clearFaceChangeRequest)

  const requested = project.features.filter((feature) => featureIds.includes(feature.id))
  const fromFace: SetupFace = requested[0]?.authoringFace ?? 'top'
  const toFace = oppositeFace(fromFace)
  // One direction per confirmation: the features on the first one's face.
  const movable = requested.filter((feature) => feature.authoringFace === fromFace && !feature.locked)
  const lockedCount = requested.filter((feature) => feature.locked).length
  // Linked copies that stay behind keep sharing the shape across the faces.
  const linkedStaying = linkedCopiesOffFace(project, movable.map((feature) => feature.id), toFace)
  const faceName = (face: SetupFace) => t(face === 'top' ? 'featureTree.face.topFace' : 'featureTree.face.bottomFace')

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [close])

  function confirm() {
    setFeatureAuthoringFace(movable.map((feature) => feature.id), toFace)
    close()
  }

  const title = movable.length === 1
    ? t(toFace === 'top' ? 'featureTree.face.dialog.titleOneToTop' : 'featureTree.face.dialog.titleOneToBottom', { name: movable[0].name })
    : t(toFace === 'top' ? 'featureTree.face.dialog.titleManyToTop' : 'featureTree.face.dialog.titleManyToBottom', { count: movable.length })

  return createPortal(
    <div className="dialog-backdrop" onClick={close}>
      <div
        className="dialog dialog--change-face"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="change-face-title"
        aria-describedby="change-face-description"
      >
        <div className="dialog-header">
          <h2 className="dialog-title" id="change-face-title">{title}</h2>
          <button className="dialog-close" onClick={close} aria-label={t('dialogs.common.close')} type="button">
            ✕
          </button>
        </div>

        <div className="dialog-body change-face">
          <div className="change-face__route" aria-hidden="true">
            <FaceChip face={fromFace} />
            <span className="change-face__arrow">→</span>
            <FaceChip face={toFace} />
          </div>
          <p id="change-face-description" className="change-face__intro">
            {t('featureTree.face.dialog.intro')}
          </p>

          {movable.length > 0 ? (
            <table className="change-face__table">
              <thead>
                <tr>
                  <th scope="col">{movable.length === 1 ? '' : t('featureTree.face.dialog.feature')}</th>
                  <th scope="col">{t('featureTree.face.dialog.now')}</th>
                  <th scope="col">{t('featureTree.face.dialog.after')}</th>
                </tr>
              </thead>
              {movable.length === 1 ? (
                <tbody>
                  <tr>
                    <th scope="row">{t('featureTree.face.dialog.measuredFrom')}</th>
                    <td>{faceName(fromFace)}</td>
                    <td>{faceName(toFace)}</td>
                  </tr>
                  <tr>
                    <th scope="row">{t('featureTree.properties.zRange')}</th>
                    <td className="change-face__value" data-testid="change-face-z-now">{formatZRange(project, movable[0], fromFace)}</td>
                    <td className="change-face__value" data-testid="change-face-z-after">{formatZRange(project, movable[0], toFace)}</td>
                  </tr>
                  <tr>
                    <th scope="row">{t('featureTree.face.stockSpan')}</th>
                    <td className="change-face__value" data-testid="change-face-span-now">{formatSpan(project, movable[0])}</td>
                    <td className="change-face__value" data-testid="change-face-span-after">{formatSpan(project, movable[0])}</td>
                  </tr>
                </tbody>
              ) : (
                <tbody>
                  {movable.slice(0, LISTED_FEATURES).map((feature) => (
                    <tr key={feature.id}>
                      <th scope="row">{feature.name}</th>
                      <td className="change-face__value">{formatZRange(project, feature, fromFace)}</td>
                      <td className="change-face__value">{formatZRange(project, feature, toFace)}</td>
                    </tr>
                  ))}
                </tbody>
              )}
            </table>
          ) : null}
          {movable.length > LISTED_FEATURES ? (
            <p className="change-face__more">{t('featureTree.face.dialog.more', { count: movable.length - LISTED_FEATURES })}</p>
          ) : null}
          {movable.length > 1 ? (
            <p className="change-face__more">{t('featureTree.face.dialog.spanUnchanged')}</p>
          ) : null}
          {linkedStaying > 0 ? (
            <p className="change-face__linked" data-testid="change-face-linked">
              {t(
                `featureTree.face.dialog.linkedStay.${fromFace}.${linkedStaying === 1 ? 'one' : 'other'}`,
                { count: linkedStaying },
              )}
            </p>
          ) : null}
          {lockedCount > 0 ? (
            <p className="change-face__more">{t('featureTree.face.dialog.lockedSkipped', { count: lockedCount })}</p>
          ) : null}
        </div>

        <div className="dialog-footer">
          <button className="btn-secondary" type="button" onClick={close}>
            {t('dialogs.common.cancel')}
          </button>
          <button
            className="btn-primary"
            type="button"
            onClick={confirm}
            disabled={movable.length === 0}
            autoFocus
          >
            {t(toFace === 'top' ? 'featureTree.face.dialog.moveToTop' : 'featureTree.face.dialog.moveToBottom')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
