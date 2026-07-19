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

/** Simplified Chinese design-print footer content. */
export const printZhCN: Record<keyof typeof printEn, string> = {
  'print.scale.fit': '适合页面（{ratio}）',
  'print.orientation.landscape': '横向',
  'print.orientation.portrait': '纵向',
  'print.units.inch': '英寸',
  'print.footer.units': '单位：{units}',
  'print.footer.scale': '比例：{scale}',
  'print.footer.paper': '纸张：{paper} · {orientation}',
}
