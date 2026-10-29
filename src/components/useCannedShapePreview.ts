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
 *    document change) cancels the transaction, which restores the project
 *    snapshot taken before the first preview write.
 *
 * A transaction another edit opened is never adopted: only the one this hook
 * opened is committed or cancelled.
 */

import { useCallback, useEffect, useRef } from 'react'
import type { CannedShapeData, Project } from '../types/project'
import { useProjectStore } from '../store/projectStore'
import { cannedParamsKey } from '../cannedShapes/cache'

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
      const snapshot = snapshotRef.current
      if (committedRef.current || snapshot === null) return
      if (transactionSignature(useProjectStore.getState().history.transactionStart)
        !== transactionSignature(snapshot)) return
      cancelHistoryTransaction()
    }
  }, [editing, cancelHistoryTransaction])

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
