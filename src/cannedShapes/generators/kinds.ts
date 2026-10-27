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
 * Registry keys for the flat canned shapes (issue #1112 slice D).
 *
 * Creation actions and the generators must agree on the stored `kind`, so the
 * key lives once here rather than as a literal in two files.
 */

export const ELLIPSE_CANNED_KIND = 'ellipse'
export const SLOT_CANNED_KIND = 'slot'
export const NGON_CANNED_KIND = 'ngon'
export const ROUND_RECT_CANNED_KIND = 'roundrect'
export const CHAMFER_RECT_CANNED_KIND = 'chamferrect'
