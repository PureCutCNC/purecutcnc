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

import { useProjectStore } from '../../store/projectStore'
import { projectUsesBothFaces } from '../../store/helpers/activeFace'
import { FaceSwitch } from './FaceSwitch'
import { machineMode, showsFaceSwitch } from '../cam/machineMode'

interface FaceBannerProps {
  /**
   * Carry the face switch in the row. Tablet shells have no workspace header
   * and no room in the top command bar, so the switch lives here.
   */
  withSwitch?: boolean
}

/**
 * The row above the sketch that carries the face switch on a tablet shell
 * (issue #945, #1102 slice E). It holds nothing else: a desktop shell keeps the
 * switch in the workspace header and shows no row at all, and the switch
 * itself explains the flip and the Around view through its tooltips, so the
 * row cannot be cut off at tablet width.
 */
export function FaceBanner({ withSwitch = false }: FaceBannerProps) {
  const bothFaces = useProjectStore((state) => projectUsesBothFaces(state.project))
  const machine = useProjectStore((state) => machineMode(state.project))
  // The row only exists when it has something to carry: a hidden switch must
  // not leave an empty banner behind, and a desktop shell has no row at all.
  if (!withSwitch || !showsFaceSwitch(machine, bothFaces)) return null

  return (
    <div className="face-banner">
      <FaceSwitch />
    </div>
  )
}
