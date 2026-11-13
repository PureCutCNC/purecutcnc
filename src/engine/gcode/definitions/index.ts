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

import { resolveMachineKind } from '../types'
import type { MachineDefinition, MachineKind } from '../types'
import type { Project } from '../../../types/project'
import generic from './generic.json'
import grbl from './grbl.json'
import mach3 from './mach3.json'
import linuxcnc from './linuxcnc.json'
import grblhal from './grblhal.json'
import uccnc from './uccnc.json'
import shopbot from './shopbot.json'
import qtplasmac from './qtplasmac.json'
import grblPlasma from './grbl-plasma.json'

type RotaryBlock = NonNullable<MachineDefinition['rotary']>

/**
 * A bundled rotary machine (#1153): the base controller profile, byte for byte,
 * plus a rotary block and its own id, name and description. It is derived
 * rather than copied into its own JSON so a later fix to the base reaches the
 * rotary machine too.
 *
 * The block names no `about`: the machine follows the project's bar, so one
 * machine serves a bar along X and a bar along Y (`pinRotaryAxis`). It names no
 * `zeroA`, so the program pauses between rotary operations for the operator to
 * zero A by hand until they fill one in on their own copy (#1103 ca-h).
 */
function rotaryVariant(
  base: MachineDefinition,
  variant: { id: string; name: string; description: string; rotary: RotaryBlock },
): MachineDefinition {
  const {
    id: _id, name: _name, description: _description, builtin, fileExtension, coordinateSystem, ...body
  } = structuredClone(base)
  // The rotary key sits where the schema declares it, before the coordinate
  // system, so the definition reads the way a parsed one does.
  return {
    id: variant.id,
    name: variant.name,
    description: variant.description,
    builtin,
    fileExtension,
    rotary: variant.rotary,
    coordinateSystem,
    ...body,
  }
}

const INVERSE_TIME = { on: 'G93', off: 'G94' }
const ownAxis = (extra: Partial<RotaryBlock> = {}): RotaryBlock => ({
  drive: 'own', reversed: false, inverseTimeFeed: INVERSE_TIME, ...extra,
})

const baseGrbl = grbl as unknown as MachineDefinition
const baseGrblhal = grblhal as unknown as MachineDefinition
const baseLinuxcnc = linuxcnc as unknown as MachineDefinition
const baseMach3 = mach3 as unknown as MachineDefinition
const baseUccnc = uccnc as unknown as MachineDefinition

/**
 * The bundled rotary machines (#1153), one per controller. Each description is
 * the setup the controller needs before it can run these programs: A counts
 * far past 360° (no wrap, #1091), so soft limits and any 360° rollover must be
 * off for it.
 */
export const BUNDLED_ROTARY_DEFINITIONS: MachineDefinition[] = [
  rotaryVariant(baseGrbl, {
    id: 'grbl-rotary',
    name: 'GRBL 1.1 + rotary (borrowed motor)',
    description: 'GRBL 1.1 with the rotary on the Y driver for a bar along X, or the X driver for a bar along Y. Set that axis\'s steps/mm as steps per degree and turn soft limits off ($20=0). Rotary programs are in mm only.',
    rotary: { drive: 'borrowed', reversed: false, inverseTimeFeed: INVERSE_TIME },
  }),
  rotaryVariant(baseGrbl, {
    id: 'grbl-rotary-a',
    name: 'GRBL 4-axis fork + rotary A',
    description: 'Grbl 1.1 fork with a fourth axis A (Monport-type boards). The firmware scales A by 25.4 under G20, so rotary programs are in mm only. Turn soft limits off ($20=0) or set $133 past any job; in gSender enable \'Use A-axis for grbl\'.',
    rotary: ownAxis({ angleScalesWithUnits: true }),
  }),
  rotaryVariant(baseGrblhal, {
    id: 'grblhal-rotary',
    name: 'grblHAL + rotary A',
    description: 'grblHAL with a rotary A axis. Put A in the rotary axes setting ($376) and turn soft limits off ($20=0) or set $133 past any job.',
    rotary: ownAxis(),
  }),
  rotaryVariant(baseMach3, {
    id: 'mach3-rotary',
    name: 'Mach3 + rotary A',
    description: 'Mach3 with a rotary A axis. Tick A as angular, turn Rot 360 rollover off, and turn A soft limits off: A counts past 360°.',
    rotary: ownAxis(),
  }),
  rotaryVariant(baseUccnc, {
    id: 'uccnc-rotary',
    name: 'UCCNC + rotary A',
    description: 'UCCNC 1.2105 or later (G93) with a rotary A axis. Turn the 360° rollover and A soft limits off: A counts past 360°.',
    rotary: ownAxis(),
  }),
  rotaryVariant(baseLinuxcnc, {
    id: 'linuxcnc-rotary',
    name: 'LinuxCNC + rotary A',
    description: 'LinuxCNC with an angular A axis. Set [AXIS_A] MIN_LIMIT/MAX_LIMIT wide and leave WRAPPED_ROTARY off: A counts past 360°.',
    rotary: ownAxis(),
  }),
]

export const BUNDLED_DEFINITIONS: MachineDefinition[] = [
  generic as unknown as MachineDefinition,
  grbl as unknown as MachineDefinition,
  grblhal as unknown as MachineDefinition,
  mach3 as unknown as MachineDefinition,
  uccnc as unknown as MachineDefinition,
  linuxcnc as unknown as MachineDefinition,
  // The one bundled definition that is not G-code (issue #953): it exports
  // ShopBot part files through `opensbpEmitter.ts`. Its G-code command words
  // are never read by this build. They are comment-prefixed on purpose, so a
  // build that predates `outputDialect` — which ignores that field and takes
  // the G-code path — writes a file of comments, not G-code, into a `.sbp`.
  shopbot as unknown as MachineDefinition,
  // Metadata only (#956). Torch sequencing belongs to motionPipeline (#959).
  qtplasmac as unknown as MachineDefinition,
  grblPlasma as unknown as MachineDefinition,
  ...BUNDLED_ROTARY_DEFINITIONS,
]

/**
 * The export boundary: G-code generation, preview, exported-motion
 * inspection, and file-extension selection all resolve the machine through
 * this function, and it reads **only** the project's own embedded snapshot.
 * The application machine library (`src/machine/`) is deliberately not
 * consulted, so a library edit or an app upgrade can never change what a
 * project exports until the user explicitly updates the project copy.
 */
export function getActiveMachineDefinition(project: Project): MachineDefinition | null {
  if (!project.meta.selectedMachineId) {
    return null
  }

  return project.meta.machineDefinitions.find((definition) => definition.id === project.meta.selectedMachineId) ?? null
}

/**
 * The kind of the machine this project cuts on, resolved from the same embedded
 * snapshot `getActiveMachineDefinition` reads. A project with no machine
 * selected is a router project.
 */
export function projectMachineKind(project: Project): MachineKind {
  const definition = getActiveMachineDefinition(project)
  return definition ? resolveMachineKind(definition) : 'router'
}
