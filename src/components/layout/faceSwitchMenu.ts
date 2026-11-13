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
 * What the header's one compact face control opens (issue #1112 slice B,
 * decision 6; carried from #1107). The control names the current face and its
 * flip; the menu lists the faces and the "Show other side" overlay, replacing
 * the old segmented pills, the flip chip and the eye.
 *
 * The rules live here, apart from the markup, so the two things that are easy
 * to get wrong are pinned by a test: which faces the project has at all, and
 * which of them the edit-in-progress rule refuses.
 */

import type { SetupFace } from '../../types/project'

/** The label of a face, in the header control and in its menu entries. */
export type FaceLabelKey =
  | 'appShell.face.top'
  | 'appShell.face.bottom'
  | 'appShell.face.around'

/**
 * The sentence a face entry explains itself with. A refused entry says why it
 * is refused instead ({@link BUSY_TITLE}); Around keeps its unrolled-view note.
 */
export type FaceTitleKey =
  | 'appShell.face.busy'
  | 'appShell.face.switchToTop'
  | 'appShell.face.switchToBottom'
  | 'canvas.face.aroundTurnsBar'

const BUSY_TITLE: FaceTitleKey = 'appShell.face.busy'

/** One face the menu offers. */
export interface FaceMenuItem {
  face: SetupFace
  icon: string
  labelKey: FaceLabelKey
  /** The workspace is on this face. */
  checked: boolean
  /** Refused: an edit, move or combine is in progress on the current face. */
  disabled: boolean
  titleKey: FaceTitleKey
}

/** The "Show other side" overlay entry, or null when there is no other side. */
export interface FaceOtherSideItem {
  checked: boolean
}

export interface FaceMenuModel {
  items: FaceMenuItem[]
  otherSide: FaceOtherSideItem | null
}

export interface FaceMenuInput {
  /** The face the workspace is on. */
  face: SetupFace
  /** The project has an Around face at all: a rotary project on a bar (#1028). */
  aroundAvailable: boolean
  /** The project carries more than one face: only then is there another side. */
  bothFaces: boolean
  /** The project has anything on Bottom, so Top has an other side to show. */
  hasBottomContent: boolean
  /** A feature is being edited, moved or combined: the face stays put. */
  busy: boolean
  /** The ghost overlay is currently drawn. */
  showOtherSide: boolean
}

const FACE_ICONS: Readonly<Record<SetupFace, string>> = {
  top: 'face-top',
  bottom: 'face-bottom',
  around: 'face-around',
}

const FACE_LABELS: Readonly<Record<SetupFace, FaceLabelKey>> = {
  top: 'appShell.face.top',
  bottom: 'appShell.face.bottom',
  around: 'appShell.face.around',
}

const FACE_TITLES: Readonly<Record<SetupFace, FaceTitleKey>> = {
  top: 'appShell.face.switchToTop',
  bottom: 'appShell.face.switchToBottom',
  around: 'canvas.face.aroundTurnsBar',
}

/** The order the faces are listed in, whatever the current face. */
const FACE_ORDER: readonly SetupFace[] = ['top', 'bottom', 'around']

/** The icon a face wears, in the control and in its menu entry. */
export function faceIcon(face: SetupFace): string {
  return FACE_ICONS[face]
}

/** The label of a face, in the control and in its menu entries. */
export function faceLabelKey(face: SetupFace): FaceLabelKey {
  return FACE_LABELS[face]
}

/**
 * The menu's contents: every face the project has, and the other-side overlay
 * when there is another side to show. A face other than the current one is
 * refused while an edit is in progress, so the action can never land on a
 * ghost — the same rule the old segmented control carried.
 */
export function faceMenu({
  face,
  aroundAvailable,
  bothFaces,
  hasBottomContent,
  busy,
  showOtherSide,
}: FaceMenuInput): FaceMenuModel {
  const items = FACE_ORDER
    // Around only exists on a rotary project with a bar; a block or a milling
    // project has no unrolled surface to offer (#1028).
    .filter((entry) => entry !== 'around' || aroundAvailable)
    .map((entry): FaceMenuItem => {
      const checked = entry === face
      const refused = busy && !checked
      return {
        face: entry,
        icon: FACE_ICONS[entry],
        labelKey: FACE_LABELS[entry],
        checked,
        disabled: refused,
        titleKey: refused ? BUSY_TITLE : FACE_TITLES[entry],
      }
    })

  // The overlay compares the two flat faces only: Around is not a half-turn of
  // either, so it is never shown there. Top has a side to show only once the
  // project carries something on Bottom.
  const hasOtherSide = bothFaces && face !== 'around' && (face !== 'top' || hasBottomContent)

  return {
    items,
    otherSide: hasOtherSide ? { checked: showOtherSide } : null,
  }
}
