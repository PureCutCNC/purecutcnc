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

/** Screen-space butt-capped line quads; no depth or perspective. */
export const maskVertexShader = `
  attribute vec4 endpoints;
  uniform vec3 view;
  uniform vec2 viewport;
  uniform float lineWidth;
  varying float along;
  void main() {
    vec2 delta = endpoints.zw - endpoints.xy;
    float lengthPx = length(delta) * view.x;
    vec2 direction = delta / max(length(delta), 0.000001);
    vec2 point = mix(endpoints.xy, endpoints.zw, position.x) * view.x + view.yz;
    point += vec2(-direction.y, direction.x) * position.y * lineWidth;
    along = position.x * lengthPx;
    gl_Position = vec4(point.x / viewport.x * 2.0 - 1.0, 1.0 - point.y / viewport.y * 2.0, 0.0, 1.0);
  }
`
export const maskFragmentShader = `
  uniform float dashed;
  varying float along;
  void main() {
    if (dashed > 0.5 && mod(along, 7.0) >= 3.0) discard;
    gl_FragColor = vec4(1.0);
  }
`
export const compositeVertexShader = `
  varying vec2 sampleUv;
  void main() {
    sampleUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`
export const compositeFragmentShader = `
  uniform sampler2D coverage;
  uniform vec3 stroke;
  uniform float alpha;
  varying vec2 sampleUv;
  void main() {
    // Colour is already display-referred sRGB, matching Canvas CSS colours.
    gl_FragColor = vec4(stroke, texture2D(coverage, sampleUv).r * alpha);
  }
`

