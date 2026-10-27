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
import { test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nProvider } from '../../i18n/I18nProvider'
import { roundStock, type Clamp } from '../../types/project'
import { defaultRoundWorkholding } from '../../store/helpers/roundWorkholding'
import { ChuckProperties, ChuckRangeWarning } from './ChuckProperties'

test('Properties shows capacity warning and equipment fields, and preserves legacy size until picked', () => {
  const stock = roundStock(20, 100, 'x')
  const clamp: Clamp = { id: 'c', name: 'Chuck', visible: true, ...defaultRoundWorkholding('chuck', stock, 'mm') }
  const render = (value: Clamp) => renderToStaticMarkup(<I18nProvider><ChuckProperties clamp={value} stock={stock} units="mm" onChange={() => {}} /></I18nProvider>)
  assert.doesNotMatch(render(clamp), /role="alert"/)
  const limited = { ...clamp, chuck: { ...clamp.chuck, clampingRangeMm: { min: 1, max: 10 } } }
  const html = render(limited)
  assert.match(html, /role="alert"/)
  assert.match(html, /outside the chuck/)
  assert.match(html, /Chuck size/)
  assert.match(html, /Minimum grip diameter/)
  assert.match(html, /Maximum grip diameter/)
  assert.match(html, /Jaws/)
  const chip = renderToStaticMarkup(<I18nProvider><ChuckRangeWarning clamp={limited} stock={stock} units="mm" compact /></I18nProvider>)
  assert.match(chip, /role="img"/)
  assert.match(chip, /aria-label="Bar is outside/)
  const legacy = { ...clamp }; delete legacy.chuck
  assert.match(render(legacy), /Existing size/)
  assert.match(render(legacy), /Capacity unknown/)
  assert.equal(legacy.chuck, undefined)
})
