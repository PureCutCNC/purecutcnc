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

import assert from 'node:assert/strict'
import { TOOLPATH_RENDERER_CODEC, toolpathRendererOverride } from './toolpathRendererPreference'

for (const choice of ['canvas', 'gpu'] as const) {
  assert.equal(TOOLPATH_RENDERER_CODEC.deserialize(TOOLPATH_RENDERER_CODEC.serialize(choice)), choice)
  assert.equal(toolpathRendererOverride('?toolpathRenderer=' + choice, true), choice)
  assert.equal(toolpathRendererOverride('?toolpathRenderer=' + choice, false), null)
}
for (const invalid of ['', 'auto', 'webgl', 'GPU', '"gpu"', 'null']) {
  assert.throws(() => TOOLPATH_RENDERER_CODEC.deserialize(invalid))
  assert.equal(toolpathRendererOverride('?toolpathRenderer=' + invalid, true), null)
}
assert.equal(toolpathRendererOverride('', true), null)
console.log('toolpathRendererPreference tests passed')
