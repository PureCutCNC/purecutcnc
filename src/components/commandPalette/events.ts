/**
 * Copyright 2026 Maik Rolf
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
 * The palette host lives in AppShell; toolbar buttons live in the toolbar
 * assemblies. This event lets a pointer/touch user open the palette without
 * reaching for Ctrl/Cmd+K.
 */
export const COMMAND_PALETTE_OPEN_EVENT = 'purecutcnc:command-palette:open'
