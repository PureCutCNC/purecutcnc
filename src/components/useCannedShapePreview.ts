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
 * Live preview while a canned shape's parameters are edited (issue #1112 F1).
 *
 * Three surfaces edit canned parameters — the canvas side panel for the five
 * flat shapes and the gear, and the two rotary dialogs for Thread/Flutes and
 * Turn/Polygon. Each keeps its own draft so Cancel can put the stored shape
 * back exactly; without a preview the shape only changed once Apply was
 * clicked, which is the bug Frank reported ("while editing a canned operation's
 * parameters its shape does not get updated").
 *
 * One place is where the draft meets the project:
 *
 *  - the draft the editor opened with *is* the stored shape, so it is not
 *    written — an editor opened and cancelled without a change leaves the
 *    project (and its dirty flag) alone,
 *  - every later valid draft is written straight into the project through the
 *    ordinary `updateFeature` path, inside one history transaction, so the
 *    sketch, the 3D preview, hit testing and the generated-outline cache all
 *    follow the field being typed in,
 *  - a draft the generator refuses is never written, so the last valid preview
 *    stays on screen while the editor shows its own error,
 *  - `commitPreview` writes the final draft and closes the transaction, which
 *    turns the whole edit into one undo step,
 *  - unloading without it (Cancel, Escape, a backdrop click, a face, unit or
 *    document change) puts back **only the data the preview wrote** — the
 *    shape's stored parameters, which the store re-derives everything else
 *    from. Anything else that changed while the editor was open (a stock
 *    resize, a unit switch, a deletion) belongs to the user and stays: a
 *    preview must not be able to discard an unrelated edit (#1112 F1 review).
 *    When nothing else changed the transaction is cancelled, which is also
 *    what leaves no undo entry; when something did, the session is committed
 *    instead, so one undo takes the project back to where the editor opened.
 *
 * A transaction another edit opened is never adopted: only the one this hook
 * opened is committed or cancelled.
 */

import { useCallback, useEffect, useRef } from 'react'
import type { CannedShapeData, Project } from '../types/project'
import { useProjectStore } from '../store/projectStore'
import { cannedParamsKey } from '../cannedShapes/cache'
import { convertCannedShapeData } from '../cannedShapes'
import { convertLength, type Units } from '../utils/units'

/** Fields an editor writes together with the parameters (a Flutes Z span). */
export interface CannedShapePreviewSpan {
  z_top: number
  z_bottom: number
}

export interface CannedShapePreviewOptions {
  /** The row being edited; `null` while creating a new shape. */
  featureId: string | null
  /** The draft's parameters, or `null` while a field holds an unusable value. */
  draft: CannedShapeData | null
  /** Extra fields the editor's Apply writes together with the parameters. */
  span?: CannedShapePreviewSpan | null
}

export interface CannedShapePreview {
  /**
   * Write the editor's final draft and close the preview as one undo step.
   * The caller passes the draft it is applying, so a click that lands before
   * the preview effect ran cannot commit a stale value.
   */
  commitPreview: (draft: CannedShapeData | null, span?: CannedShapePreviewSpan | null) => void
}

/**
 * Which transaction a snapshot belongs to. Comparing object identity is not
 * enough: a unit switch converts the open transaction's snapshot with the
 * project (so cancelling an edit cannot revert the switch), and the converted
 * copy carries the same `meta.modified` stamp. A transaction another edit
 * begins carries a different one.
 */
function transactionSignature(snapshot: Project | null): string | null {
  return snapshot ? snapshot.meta.modified : null
}

/**
 * Canonical identity of one preview write. The parameters inside a draft are
 * compared by value — the same key the outline cache uses — so re-rendering the
 * editor for any other reason never writes the project again.
 */
function previewKey(draft: CannedShapeData | null, span: CannedShapePreviewSpan | null): string | null {
  if (!draft) return null
  const key = `${draft.kind}\u0000${cannedParamsKey(draft.params)}`
  return span ? `${key}\u0000${span.z_top}\u0000${span.z_bottom}` : key
}

/**
 * The shape parameters a preview overwrote, as they were in the project
 * snapshot taken before the first write, expressed in the units the project is
 * in now: a unit switch converts the open transaction's snapshot with the
 * project, so the shape must come back as the same physical size, not the same
 * number (#1112 F1).
 *
 * Only the parameters are restored. Everything else the preview derived from
 * them — the definition's placement frame, a model's mesh asset, every
 * instance's Z span, a Thread/Flutes band following the surface under it — is
 * rebuilt by the store on this one write, so putting a derived value back by
 * hand would only fight the resolver.
 */
function baselineCanned(
  snapshot: Project,
  featureId: string,
  units: Units,
): CannedShapeData | null {
  const instance = snapshot.features.find((row) => row.id === featureId)
  if (!instance) return null
  const stored = snapshot.featureDefinitions[instance.definitionId]?.canned
  if (!stored) return null
  return convertCannedShapeData(
    stored,
    (value) => convertLength(value, snapshot.meta.units, units),
  )
}

/**
 * Whether the project differs from this snapshot by nothing but the modified
 * stamp the store writes on every change. Comparing after the preview fields
 * have been put back answers "was there any other edit at all?" without having
 * to watch every action the user could take while an editor is open.
 */
function unchangedApartFromStamp(project: Project, snapshot: Project): boolean {
  const canonical = (value: Project): string => {
    const { modified: _modified, ...meta } = value.meta
    return JSON.stringify({ ...value, meta })
  }
  return canonical(project) === canonical(snapshot)
}

export function useCannedShapePreview({
  featureId,
  draft,
  span = null,
}: CannedShapePreviewOptions): CannedShapePreview {
  const beginHistoryTransaction = useProjectStore((state) => state.beginHistoryTransaction)
  const commitHistoryTransaction = useProjectStore((state) => state.commitHistoryTransaction)
  const cancelHistoryTransaction = useProjectStore((state) => state.cancelHistoryTransaction)
  const updateFeature = useProjectStore((state) => state.updateFeature)

  const editing = featureId !== null
  // The snapshot this editor owns, or `null` when it owns no transaction.
  const snapshotRef = useRef<Project | null>(null)
  // Apply was clicked: the transaction belongs to the undo history now.
  const committedRef = useRef(false)
  // The draft the editor opened with has been seen (and deliberately not written).
  const openedRef = useRef(false)
  const writtenRef = useRef<string | null>(null)

  const writeDraft = useCallback((next: CannedShapeData, extra: CannedShapePreviewSpan | null) => {
    if (featureId === null) return
    const store = useProjectStore.getState()
    // An undo (or another edit) can end the transaction underneath an open
    // editor: give up ownership rather than cancelling someone else's.
    if (snapshotRef.current !== null
      && transactionSignature(store.history.transactionStart) !== transactionSignature(snapshotRef.current)) {
      snapshotRef.current = null
    }
    if (snapshotRef.current === null && store.history.transactionStart === null) {
      beginHistoryTransaction()
      snapshotRef.current = useProjectStore.getState().history.transactionStart
    }
    updateFeature(featureId, extra ? { canned: next, ...extra } : { canned: next })
  }, [beginHistoryTransaction, featureId, updateFeature])

  useEffect(() => {
    if (!editing) return
    const key = previewKey(draft, span)
    if (!openedRef.current) {
      openedRef.current = true
      writtenRef.current = key
      return
    }
    if (key === null || key === writtenRef.current) return
    writtenRef.current = key
    writeDraft(draft as CannedShapeData, span)
  }, [editing, draft, span, writeDraft])

  useEffect(() => {
    if (!editing) return undefined
    return () => {
      const target = featureId
      const snapshot = snapshotRef.current
      if (target === null || committedRef.current || snapshot === null) return
      if (transactionSignature(useProjectStore.getState().history.transactionStart)
        !== transactionSignature(snapshot)) return
      // Put back the shape's own parameters first, so what remains of the
      // transaction is everything the user changed elsewhere while the editor
      // was open. The write goes through the ordinary path, so the regenerated
      // outlines, mesh asset, Z spans and surface bands follow the restored
      // parameters (#1112 F1).
      const restore = baselineCanned(
        snapshot,
        target,
        useProjectStore.getState().project.meta.units,
      )
      if (restore) updateFeature(target, { canned: restore })
      if (unchangedApartFromStamp(useProjectStore.getState().project, snapshot)) {
        // Nothing else happened: put the snapshot back whole. That is also the
        // one path that closes the transaction without an undo entry.
        cancelHistoryTransaction()
      } else {
        // The other changes stay. Committing makes them one undo step whose
        // "before" is the state the editor opened on.
        commitHistoryTransaction()
      }
    }
  }, [editing, featureId, updateFeature, cancelHistoryTransaction, commitHistoryTransaction])

  const commitPreview = useCallback((
    finalDraft: CannedShapeData | null,
    finalSpan: CannedShapePreviewSpan | null = null,
  ) => {
    if (!editing) return
    committedRef.current = true
    if (finalDraft !== null) {
      writeDraft(finalDraft, finalSpan)
    }
    const snapshot = snapshotRef.current
    if (snapshot !== null
      && transactionSignature(useProjectStore.getState().history.transactionStart) === transactionSignature(snapshot)) {
      commitHistoryTransaction()
    }
  }, [editing, writeDraft, commitHistoryTransaction])

  return { commitPreview }
}
