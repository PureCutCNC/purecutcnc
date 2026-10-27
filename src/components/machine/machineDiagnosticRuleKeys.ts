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
 * The catalog key for every machine-template rule code (#1119). The engine
 * emits only the code; this table is the one place the UI chooses the
 * translated name, so a missing translation is a compile error and no surface
 * can fall back to an English label.
 */

import type { MachineTemplateRuleCode } from '../../engine/gcode/templateRules'
import type { dialogsEn } from '../../i18n/locales/en/dialogs'

export const MACHINE_TEMPLATE_RULE_KEY: Record<MachineTemplateRuleCode, keyof typeof dialogsEn> = {
  'comment-syntax': 'dialogs.machineDiagnostics.ruleName.comment-syntax',
  'header': 'dialogs.machineDiagnostics.ruleName.header',
  'inert.operation-header': 'dialogs.machineDiagnostics.ruleName.inert.operation-header',
  'inert.spindle-on': 'dialogs.machineDiagnostics.ruleName.inert.spindle-on',
  'inert.spindle-off': 'dialogs.machineDiagnostics.ruleName.inert.spindle-off',
  'inert.pause': 'dialogs.machineDiagnostics.ruleName.inert.pause',
  'inert.coolant': 'dialogs.machineDiagnostics.ruleName.inert.coolant',
  'units': 'dialogs.machineDiagnostics.ruleName.units',
  'inverse-time-on': 'dialogs.machineDiagnostics.ruleName.inverse-time-on',
  'inverse-time-off': 'dialogs.machineDiagnostics.ruleName.inverse-time-off',
  'torch': 'dialogs.machineDiagnostics.ruleName.torch',
  'material': 'dialogs.machineDiagnostics.ruleName.material',
  'material-feed': 'dialogs.machineDiagnostics.ruleName.material-feed',
  'canned-cycle': 'dialogs.machineDiagnostics.ruleName.canned-cycle',
  'canned-retract': 'dialogs.machineDiagnostics.ruleName.canned-retract',
  'canned-cancel': 'dialogs.machineDiagnostics.ruleName.canned-cancel',
  'anything': 'dialogs.machineDiagnostics.ruleName.anything',
  'tool-change': 'dialogs.machineDiagnostics.ruleName.tool-change',
  'command.rapid': 'dialogs.machineDiagnostics.ruleName.command.rapid',
  'command.linear': 'dialogs.machineDiagnostics.ruleName.command.linear',
  'command.arc-cw': 'dialogs.machineDiagnostics.ruleName.command.arc-cw',
  'command.arc-ccw': 'dialogs.machineDiagnostics.ruleName.command.arc-ccw',
  'command.feed': 'dialogs.machineDiagnostics.ruleName.command.feed',
  'command.rpm': 'dialogs.machineDiagnostics.ruleName.command.rpm',
  'command.peck': 'dialogs.machineDiagnostics.ruleName.command.peck',
  'command.machine-rapid': 'dialogs.machineDiagnostics.ruleName.command.machine-rapid',
  'command.probe': 'dialogs.machineDiagnostics.ruleName.command.probe',
  'command.set-zero': 'dialogs.machineDiagnostics.ruleName.command.set-zero',
}
