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
 * Find pockets and holes (issue #1206): runs the detector on one imported
 * model, lists what it found, and draws the checked rows as ordinary features.
 *
 * The list has no settings. It has two groups: the solids, the bodies the
 * cavities are cut out of, and the pockets and holes. A solid starts
 * unchecked, because most runs only want the pockets. A cavity is a row; a boss
 * standing in a pocket is shown under it and always goes with it. Rows that
 * match a shape already in the project start unchecked, so running this twice
 * adds nothing twice.
 *
 * The preview is the dialog's own: the model's outline with every shape on it,
 * the solids under the cavities, the active row lit. The sketch behind a modal
 * dialog is dimmed, so a highlight there would not be seen.
 *
 * The model is looked at from Top and from Bottom, whether or not the project
 * has a Bottom setup yet (issue #1206 slice 4). A row on Bottom says so with the
 * face chip, and its preview outline is dotted: it is on the far side.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { loadSTLTransformedGeometry } from '../../engine/csg'
import {
  markAlreadyDrawn,
  type CombinedRecognition,
  type RecognitionCandidate,
} from '../../engine/modelRecognition'
import { flattenProfile } from '../../engine/toolpaths/geometry'
import { useI18n } from '../../i18n/i18nContext'
import type { MessageKey } from '../../i18n/locales/en'
import { useModelRecognitionStore } from '../../store/modelRecognitionStore'
import { useProjectStore } from '../../store/projectStore'
import { modelRecognitionRefusal } from '../../store/helpers/recognizedFeatures'
import { resolveFeatureInstance } from '../../store/helpers/resolveFeatures'
import type { Point } from '../../types/project'
import { formatLength } from '../../utils/units'
import { FaceChip } from '../feature-tree/FaceChip'
import {
  candidateSize,
  defaultCheckedIds,
  drawnFeaturesOf,
  RECOGNIZED_FACES,
  shapesToDraw,
  skippedCounts,
  solidSkippedCounts,
} from './candidateRows'
import { RecognitionCancelledError } from './recognitionClient'
import { recognizeModelFaces } from './recognizeFaces'

type RunState =
  | { status: 'running'; progress: number }
  | { status: 'failed' }
  | { status: 'done'; result: CombinedRecognition }

const KIND_KEY: Record<RecognitionCandidate['kind'], MessageKey> = {
  solid: 'featureTree.findCavities.kind.solid',
  throughHole: 'featureTree.findCavities.kind.throughHole',
  blindHole: 'featureTree.findCavities.kind.blindHole',
  throughPocket: 'featureTree.findCavities.kind.throughPocket',
  pocket: 'featureTree.findCavities.kind.pocket',
  island: 'featureTree.findCavities.kind.island',
}

function pathData(points: readonly Point[]): string {
  if (points.length === 0) return ''
  return `M ${points.map((point) => `${point.x} ${point.y}`).join(' L ')} Z`
}

export function FindCavitiesDialog() {
  const modelId = useModelRecognitionStore((state) => state.requestedModelId)
  // Keyed by the model so a second request starts from a clean run.
  return modelId ? <FindCavitiesDialogBody key={modelId} modelId={modelId} /> : null
}

function FindCavitiesDialogBody({ modelId }: { modelId: string }) {
  const closeButton = useRef<HTMLButtonElement>(null)
  const { t, tPlural } = useI18n()
  const project = useProjectStore((state) => state.project)
  const addRecognizedFeatures = useProjectStore((state) => state.addRecognizedFeatures)
  const close = useModelRecognitionStore((state) => state.clearModelRecognitionRequest)
  const units = project.meta.units

  const model = useMemo(() => (
    modelRecognitionRefusal(project, modelId) ? null : resolveFeatureInstance(project, modelId)
  ), [project, modelId])

  const [run, setRun] = useState<RunState>({ status: 'running', progress: 0 })
  const [checked, setChecked] = useState<ReadonlySet<string> | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const [highlighted, setHighlighted] = useState<string | null>(null)

  useLayoutEffect(() => {
    const previous = document.activeElement
    closeButton.current?.focus({ preventScroll: true })
    return () => {
      const target = previous instanceof HTMLElement && previous !== document.body && previous.isConnected
        ? previous
        : document.querySelector<HTMLElement>('.sketch-canvas')
      target?.focus({ preventScroll: true })
    }
  }, [])

  // One run per open dialog. The project is read once, at the start: the
  // dialog is modal, so nothing else can edit the model while it is up.
  useEffect(() => {
    const state = useProjectStore.getState()
    const feature = modelRecognitionRefusal(state.project, modelId) ? null : resolveFeatureInstance(state.project, modelId)
    const mesh = feature ? loadSTLTransformedGeometry(feature, state.project) : null
    const controller = new AbortController()
    // A model with no mesh fails through the same promise as a failed run, so
    // every state change here happens in a callback.
    const job = mesh
      ? recognizeModelFaces(mesh, RECOGNIZED_FACES, state.project.meta.units, {
        signal: controller.signal,
        onProgress: (progress) => setRun({ status: 'running', progress }),
      })
      : Promise.reject<CombinedRecognition>(new Error('The model has no mesh'))
    job.then(
      (result) => setRun({ status: 'done', result }),
      (error: unknown) => {
        if (!(error instanceof RecognitionCancelledError)) setRun({ status: 'failed' })
      },
    )
    return () => controller.abort()
  }, [modelId])

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    event.stopPropagation()
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
    }
    if (event.key !== 'Tab') return
    const controls = event.currentTarget.querySelectorAll<HTMLElement>('button:enabled, input:enabled')
    const first = controls[0]
    const last = controls[controls.length - 1]
    const edge = event.shiftKey ? first : last
    if (document.activeElement !== edge && document.activeElement !== event.currentTarget) return
    event.preventDefault()
    const next = event.shiftKey ? last : first
    next?.focus()
  }

  const result = run.status === 'done' ? run.result : null
  const candidates = useMemo(() => (
    result ? markAlreadyDrawn(result.candidates, drawnFeaturesOf(project)) : []
  ), [result, project])
  const checkedIds = useMemo(() => checked ?? new Set(defaultCheckedIds(candidates)), [checked, candidates])
  // A face chip is shown only once something is on Bottom: with every row on
  // Top the list reads exactly as it did before the look from below existed.
  const showsFaces = candidates.some((candidate) => candidate.face === 'bottom')

  const modelOutline = useMemo(() => (model ? flattenProfile(model.sketch.profile).points : []), [model])
  const viewBox = useMemo(() => {
    const points = [...modelOutline, ...candidates.flatMap((candidate) => candidate.outline)]
    if (points.length === 0) return null
    const xs = points.map((point) => point.x)
    const ys = points.map((point) => point.y)
    const minX = Math.min(...xs)
    const minY = Math.min(...ys)
    const width = Math.max(...xs) - minX
    const height = Math.max(...ys) - minY
    const margin = Math.max(width, height) * 0.04
    return `${minX - margin} ${minY - margin} ${width + margin * 2} ${height + margin * 2}`
  }, [modelOutline, candidates])

  const sizeText = (candidate: RecognitionCandidate): string => {
    const size = candidateSize(candidate)
    return size.kind === 'diameter'
      ? `Ø${formatLength(size.diameter, units)}`
      : `${formatLength(size.width, units)} × ${formatLength(size.height, units)}`
  }
  const nameOf = (candidate: RecognitionCandidate): string => {
    if (candidate.kind === 'solid') return t('featureTree.findCavities.name.solid')
    if (candidate.kind === 'island') return t('featureTree.findCavities.name.island')
    if (candidate.circle) return t('featureTree.findCavities.name.hole', { size: sizeText(candidate) })
    return t('featureTree.findCavities.name.pocket')
  }
  const notesOf = (candidate: RecognitionCandidate): string[] => {
    const notes: string[] = []
    if (candidate.alreadyDrawn) notes.push(t('featureTree.findCavities.note.alreadyDrawn'))
    if (candidate.flaredAbove) notes.push(t('featureTree.findCavities.note.flared'))
    if (candidate.bottom === 'taper') notes.push(t('featureTree.findCavities.note.taper'))
    if (candidate.bottom === 'open') notes.push(t('featureTree.findCavities.note.open'))
    return notes
  }

  function toggle(id: string) {
    const next = new Set(checkedIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setChecked(next)
  }

  const shapes = shapesToDraw(candidates, checkedIds, nameOf)
  function confirm() {
    if (!model || shapes.length === 0) return
    addRecognizedFeatures({
      modelFeatureId: modelId,
      folderName: t('featureTree.findCavities.folderName', { model: model.name }),
      shapes,
    })
    close()
  }

  const skipped = result ? skippedCounts(result.skipped) : []
  const skippedSolids = result ? solidSkippedCounts(result.skippedSolids) : []
  const activeCandidate = hovered ?? highlighted
  const isLit = (candidate: RecognitionCandidate): boolean => (
    activeCandidate !== null && (candidate.parentId ?? candidate.id) === activeCandidate
  )

  const solidCandidates = candidates.filter((candidate) => candidate.kind === 'solid')
  const cavityCandidates = candidates.filter((candidate) => candidate.kind !== 'solid')
  // The preview paints in document order, so the solids go first and the
  // cavities sit on top of them.
  const previewCandidates = [...solidCandidates, ...cavityCandidates]

  const rowOf = (candidate: RecognitionCandidate) => {
    const notes = notesOf(candidate)
    const island = candidate.parentId !== null
    const Label = island ? 'span' : 'label'
    return (
      <tr
        key={candidate.id}
        className={[
          'find-cavities__row',
          island ? 'find-cavities__row--island' : '',
          isLit(candidate) ? 'find-cavities__row--lit' : '',
        ].filter(Boolean).join(' ')}
        data-testid={`find-cavities-row-${candidate.id}`}
        data-kind={candidate.kind}
        onPointerEnter={(event) => {
          if (event.pointerType === 'mouse') setHovered(candidate.parentId ?? candidate.id)
        }}
        onPointerLeave={(event) => {
          if (event.pointerType === 'mouse') setHovered(null)
        }}
      >
        <th scope="row">
          <Label className="find-cavities__label">
            {island ? null : (
              <input
                type="checkbox"
                checked={checkedIds.has(candidate.id)}
                onFocus={() => {
                  setHovered(null)
                  setHighlighted(candidate.id)
                }}
                onChange={() => {
                  setHighlighted(candidate.id)
                  toggle(candidate.id)
                }}
                aria-label={t('featureTree.findCavities.include', { name: nameOf(candidate) })}
              />
            )}
            <span>{t(KIND_KEY[candidate.kind])}</span>
            {showsFaces ? <FaceChip face={candidate.face} /> : null}
          </Label>
          {notes.length > 0 ? <span className="find-cavities__notes">{notes.join(' · ')}</span> : null}
        </th>
        <td className="find-cavities__value">{sizeText(candidate)}</td>
        <td className="find-cavities__value">{formatLength(candidate.zTop - candidate.zBottom, units)}</td>
        <td className="find-cavities__value">
          {`${formatLength(candidate.zTop, units)} → ${formatLength(candidate.zBottom, units)}`}
        </td>
      </tr>
    )
  }

  const groupOf = (kind: 'solids' | 'cavities', rows: RecognitionCandidate[]) => (
    rows.length === 0 ? null : (
      <tbody className="find-cavities__group" data-group={kind}>
        <tr className="find-cavities__group-row">
          <th scope="rowgroup" colSpan={4}>
            {t(kind === 'solids' ? 'featureTree.findCavities.group.solids' : 'featureTree.findCavities.group.cavities')}
          </th>
        </tr>
        {rows.map(rowOf)}
      </tbody>
    )
  )

  return createPortal(
    <div className="dialog-backdrop" onClick={close}>
      <div
        className="dialog dialog--find-cavities"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="find-cavities-title"
        data-testid="find-cavities-dialog"
      >
        <div className="dialog-header">
          <h2 className="dialog-title" id="find-cavities-title">
            {t('featureTree.findCavities.title', { name: model?.name ?? '' })}
          </h2>
          <button ref={closeButton} className="dialog-close" onClick={close} aria-label={t('dialogs.common.close')} type="button">
            ✕
          </button>
        </div>

        <div className="dialog-body find-cavities">
          {run.status === 'running' ? (
            <div className="find-cavities__status" data-testid="find-cavities-running">
              <p>{t('featureTree.findCavities.running')}</p>
              <div
                className="import-progress-track"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(run.progress * 100)}
              >
                <div className="import-progress-fill" style={{ ['--progress' as string]: run.progress }} />
              </div>
            </div>
          ) : null}

          {run.status === 'failed' ? (
            <p className="find-cavities__status" data-testid="find-cavities-failed">{t('featureTree.findCavities.failed')}</p>
          ) : null}

          {result ? (
            <>
              {candidates.length === 0 ? (
                <p className="find-cavities__status" data-testid="find-cavities-none">{t('featureTree.findCavities.noneFound')}</p>
              ) : (
                <div className="find-cavities__found">
                  <div className="find-cavities__list">
                    <p className="find-cavities__intro">{t('featureTree.findCavities.intro')}</p>
                    <table className="find-cavities__table">
                      <thead>
                        <tr>
                          <th scope="col">{t('featureTree.findCavities.col.shape')}</th>
                          <th scope="col">{t('featureTree.findCavities.col.size')}</th>
                          <th scope="col">{t('featureTree.findCavities.col.depth')}</th>
                          <th scope="col">{t('featureTree.findCavities.col.z')}</th>
                        </tr>
                      </thead>
                      {groupOf('solids', solidCandidates)}
                      {groupOf('cavities', cavityCandidates)}
                    </table>
                  </div>
                  {viewBox ? (
                    <svg
                      className="find-cavities__preview"
                      viewBox={viewBox}
                      role="img"
                      aria-label={t('featureTree.findCavities.preview')}
                      data-testid="find-cavities-preview"
                    >
                      <path className="find-cavities__model" d={pathData(modelOutline)} />
                      {previewCandidates.map((candidate) => (
                        <path
                          key={candidate.id}
                          className={[
                            'find-cavities__shape',
                            candidate.kind === 'solid' ? 'find-cavities__shape--solid' : '',
                            candidate.kind === 'island' ? 'find-cavities__shape--island' : '',
                            candidate.face === 'bottom' ? 'find-cavities__shape--bottom' : '',
                            checkedIds.has(candidate.parentId ?? candidate.id) ? 'find-cavities__shape--checked' : '',
                            isLit(candidate) ? 'find-cavities__shape--lit' : '',
                          ].filter(Boolean).join(' ')}
                          d={pathData(candidate.outline)}
                          onPointerEnter={(event) => {
                            if (event.pointerType === 'mouse') setHovered(candidate.parentId ?? candidate.id)
                          }}
                          onPointerLeave={(event) => {
                            if (event.pointerType === 'mouse') setHovered(null)
                          }}
                        />
                      ))}
                    </svg>
                  ) : null}
                </div>
              )}

              {skipped.length > 0 || skippedSolids.length > 0 || result.meshOpen || result.levelsTruncated ? (
                <div className="find-cavities__skipped" data-testid="find-cavities-skipped">
                  {skipped.length > 0 || skippedSolids.length > 0
                    ? <h3>{t('featureTree.findCavities.skipped.title')}</h3> : null}
                  {skipped.length > 0 || skippedSolids.length > 0 ? (
                    <ul>
                      {skipped.map((entry) => (
                        <li key={`cavity-${entry.reason}`} data-kind="cavity" data-reason={entry.reason}>
                          {tPlural(
                            entry.count,
                            `featureTree.findCavities.skipped.${entry.reason}.one`,
                            `featureTree.findCavities.skipped.${entry.reason}.other`,
                            { count: entry.count },
                          )}
                        </li>
                      ))}
                      {skippedSolids.map((entry) => (
                        <li key={`solid-${entry.reason}`} data-kind="solid" data-reason={entry.reason}>
                          {tPlural(
                            entry.count,
                            `featureTree.findCavities.solidSkipped.${entry.reason}.one`,
                            `featureTree.findCavities.solidSkipped.${entry.reason}.other`,
                            { count: entry.count },
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {result.meshOpen ? <p>{t('featureTree.findCavities.meshOpen')}</p> : null}
                  {result.levelsTruncated ? <p>{t('featureTree.findCavities.truncated')}</p> : null}
                </div>
              ) : null}
            </>
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
            disabled={shapes.length === 0}
            data-testid="find-cavities-add"
          >
            {tPlural(shapes.length, 'featureTree.findCavities.add.one', 'featureTree.findCavities.add.other', { count: shapes.length })}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
