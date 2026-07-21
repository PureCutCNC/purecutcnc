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

import type { printEn } from '../en/print'

/** French design-print footer content. */
export const printFr: Record<keyof typeof printEn, string> = {
  'print.scale.fit': 'Ajuster à la page ({ratio})',
  'print.orientation.landscape': 'Paysage',
  'print.orientation.portrait': 'Portrait',
  'print.units.inch': 'pouce',
  'print.footer.units': 'Unités : {units}',
  'print.footer.scale': 'Échelle : {scale}',
  'print.footer.paper': 'Papier : {paper} · {orientation}',
}
