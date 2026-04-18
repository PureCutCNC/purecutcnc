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
 * Shared SVG path-data parser used by icon tooling.
 *
 * Converts an SVG path `d` string into an array of .camj sketch profiles:
 *   [{ start: {x, y}, segments: [...], closed: boolean }, ...]
 *
 * Supported path commands: M/m, L/l, H/h, V/v, C/c, S/s, Q/q, T/t, A/a, Z/z.
 * Emits segments with type `'line'` or `'bezier'`. Arc commands (A/a) are
 * decomposed into cubic beziers so downstream code only needs to handle
 * lines and cubic beziers.
 */

function vectorAngle(ux, uy, vx, vy) {
  const dot = ux * vx + uy * vy;
  const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
  if (len <= 1e-9) return 0;
  const sign = ux * vy - uy * vx < 0 ? -1 : 1;
  const value = Math.min(1, Math.max(-1, dot / len));
  return sign * Math.acos(value);
}

function svgArcToBeziers(start, rx, ry, xAxisRotation, largeArc, sweep, end) {
  if (rx <= 1e-9 || ry <= 1e-9) {
    return [{ type: 'line', to: end }];
  }

  const phi = (xAxisRotation * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx2 = (start.x - end.x) / 2;
  const dy2 = (start.y - end.y) / 2;

  const x1p = cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;
  let adjustedRx = Math.abs(rx);
  let adjustedRy = Math.abs(ry);

  const lambda =
    (x1p * x1p) / (adjustedRx * adjustedRx) +
    (y1p * y1p) / (adjustedRy * adjustedRy);
  if (lambda > 1) {
    const scale = Math.sqrt(lambda);
    adjustedRx *= scale;
    adjustedRy *= scale;
  }

  const numerator =
    adjustedRx * adjustedRx * adjustedRy * adjustedRy -
    adjustedRx * adjustedRx * y1p * y1p -
    adjustedRy * adjustedRy * x1p * x1p;
  const denominator =
    adjustedRx * adjustedRx * y1p * y1p + adjustedRy * adjustedRy * x1p * x1p;
  const factor =
    denominator <= 1e-9
      ? 0
      : Math.sqrt(Math.max(0, numerator / denominator)) *
        (largeArc === sweep ? -1 : 1);

  const cxp = factor * ((adjustedRx * y1p) / adjustedRy);
  const cyp = factor * (-(adjustedRy * x1p) / adjustedRx);

  const cx = cosPhi * cxp - sinPhi * cyp + (start.x + end.x) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (start.y + end.y) / 2;

  const startAngle = vectorAngle(
    1,
    0,
    (x1p - cxp) / adjustedRx,
    (y1p - cyp) / adjustedRy,
  );
  let sweepAngle = vectorAngle(
    (x1p - cxp) / adjustedRx,
    (y1p - cyp) / adjustedRy,
    (-x1p - cxp) / adjustedRx,
    (-y1p - cyp) / adjustedRy,
  );

  if (!sweep && sweepAngle > 0) sweepAngle -= Math.PI * 2;
  else if (sweep && sweepAngle < 0) sweepAngle += Math.PI * 2;

  const segmentCount = Math.max(
    1,
    Math.ceil(Math.abs(sweepAngle) / (Math.PI / 2)),
  );
  const step = sweepAngle / segmentCount;
  const beziers = [];

  for (let i = 0; i < segmentCount; i++) {
    const angle0 = startAngle + step * i;
    const angle1 = angle0 + step;
    const alpha = (4 / 3) * Math.tan((angle1 - angle0) / 4);
    const cos0 = Math.cos(angle0);
    const sin0 = Math.sin(angle0);
    const cos1 = Math.cos(angle1);
    const sin1 = Math.sin(angle1);

    const p0 = {
      x: cx + adjustedRx * cosPhi * cos0 - adjustedRy * sinPhi * sin0,
      y: cy + adjustedRx * sinPhi * cos0 + adjustedRy * cosPhi * sin0,
    };
    const p1 = {
      x: p0.x + alpha * (-adjustedRx * cosPhi * sin0 - adjustedRy * sinPhi * cos0),
      y: p0.y + alpha * (-adjustedRx * sinPhi * sin0 + adjustedRy * cosPhi * cos0),
    };
    const p3 = {
      x: cx + adjustedRx * cosPhi * cos1 - adjustedRy * sinPhi * sin1,
      y: cy + adjustedRx * sinPhi * cos1 + adjustedRy * cosPhi * sin1,
    };
    const p2 = {
      x: p3.x + alpha * (adjustedRx * cosPhi * sin1 + adjustedRy * sinPhi * cos1),
      y: p3.y + alpha * (adjustedRx * sinPhi * sin1 - adjustedRy * cosPhi * cos1),
    };

    beziers.push({ type: 'bezier', control1: p1, control2: p2, to: p3 });
  }
  return beziers;
}

export function svgPathToProfiles(d) {
  const tokens =
    d.match(/[AaCcHhLlMmQqSsTtVvZz]|[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/g) || [];
  const profiles = [];
  let current = { x: 0, y: 0 };
  let start = { x: 0, y: 0 };
  let segments = [];
  let index = 0;
  let command = '';
  let previousCubicControl = null;
  let previousQuadraticControl = null;

  const finishSubpath = () => {
    if (segments.length > 0 || (profiles.length === 0 && tokens.length > 0)) {
      profiles.push({
        start: { ...start },
        segments: [...segments],
        closed: false,
      });
      segments = [];
    }
  };

  const nextNumber = () => parseFloat(tokens[index++]);
  const hasNumber = () =>
    index < tokens.length && !/[A-Za-z]/.test(tokens[index]);

  while (index < tokens.length) {
    if (/[A-Za-z]/.test(tokens[index])) {
      command = tokens[index++];
    }

    const absolute = command === command.toUpperCase();
    switch (command.toUpperCase()) {
      case 'M': {
        finishSubpath();
        const x = nextNumber();
        const y = nextNumber();
        current = absolute ? { x, y } : { x: current.x + x, y: current.y + y };
        start = { ...current };
        previousCubicControl = null;
        previousQuadraticControl = null;
        while (hasNumber()) {
          const lx = nextNumber();
          const ly = nextNumber();
          current = absolute
            ? { x: lx, y: ly }
            : { x: current.x + lx, y: current.y + ly };
          segments.push({ type: 'line', to: { ...current } });
        }
        break;
      }
      case 'L':
        while (hasNumber()) {
          const x = nextNumber();
          const y = nextNumber();
          current = absolute
            ? { x, y }
            : { x: current.x + x, y: current.y + y };
          segments.push({ type: 'line', to: { ...current } });
        }
        previousCubicControl = null;
        previousQuadraticControl = null;
        break;
      case 'H':
        while (hasNumber()) {
          const x = nextNumber();
          current = absolute
            ? { x, y: current.y }
            : { x: current.x + x, y: current.y };
          segments.push({ type: 'line', to: { ...current } });
        }
        previousCubicControl = null;
        previousQuadraticControl = null;
        break;
      case 'V':
        while (hasNumber()) {
          const y = nextNumber();
          current = absolute
            ? { x: current.x, y }
            : { x: current.x, y: current.y + y };
          segments.push({ type: 'line', to: { ...current } });
        }
        previousCubicControl = null;
        previousQuadraticControl = null;
        break;
      case 'C':
        while (hasNumber()) {
          const c1x = nextNumber();
          const c1y = nextNumber();
          const c2x = nextNumber();
          const c2y = nextNumber();
          const ex = nextNumber();
          const ey = nextNumber();
          const control1 = absolute
            ? { x: c1x, y: c1y }
            : { x: current.x + c1x, y: current.y + c1y };
          const control2 = absolute
            ? { x: c2x, y: c2y }
            : { x: current.x + c2x, y: current.y + c2y };
          const to = absolute
            ? { x: ex, y: ey }
            : { x: current.x + ex, y: current.y + ey };
          segments.push({ type: 'bezier', control1, control2, to });
          current = { ...to };
          previousCubicControl = control2;
          previousQuadraticControl = null;
        }
        break;
      case 'S':
        while (hasNumber()) {
          const c2x = nextNumber();
          const c2y = nextNumber();
          const ex = nextNumber();
          const ey = nextNumber();
          const control1 = previousCubicControl
            ? {
                x: 2 * current.x - previousCubicControl.x,
                y: 2 * current.y - previousCubicControl.y,
              }
            : { ...current };
          const control2 = absolute
            ? { x: c2x, y: c2y }
            : { x: current.x + c2x, y: current.y + c2y };
          const to = absolute
            ? { x: ex, y: ey }
            : { x: current.x + ex, y: current.y + ey };
          segments.push({ type: 'bezier', control1, control2, to });
          current = { ...to };
          previousCubicControl = control2;
          previousQuadraticControl = null;
        }
        break;
      case 'Q':
        while (hasNumber()) {
          const cx = nextNumber();
          const cy = nextNumber();
          const ex = nextNumber();
          const ey = nextNumber();
          const control = absolute
            ? { x: cx, y: cy }
            : { x: current.x + cx, y: current.y + cy };
          const end = absolute
            ? { x: ex, y: ey }
            : { x: current.x + ex, y: current.y + ey };

          // Quadratic → cubic elevation
          const control1 = {
            x: current.x + (2 / 3) * (control.x - current.x),
            y: current.y + (2 / 3) * (control.y - current.y),
          };
          const control2 = {
            x: end.x + (2 / 3) * (control.x - end.x),
            y: end.y + (2 / 3) * (control.y - end.y),
          };
          segments.push({ type: 'bezier', control1, control2, to: end });
          current = { ...end };
          previousQuadraticControl = control;
          previousCubicControl = null;
        }
        break;
      case 'T':
        while (hasNumber()) {
          const ex = nextNumber();
          const ey = nextNumber();
          const control = previousQuadraticControl
            ? {
                x: 2 * current.x - previousQuadraticControl.x,
                y: 2 * current.y - previousQuadraticControl.y,
              }
            : { ...current };
          const end = absolute
            ? { x: ex, y: ey }
            : { x: current.x + ex, y: current.y + ey };
          const control1 = {
            x: current.x + (2 / 3) * (control.x - current.x),
            y: current.y + (2 / 3) * (control.y - current.y),
          };
          const control2 = {
            x: end.x + (2 / 3) * (control.x - end.x),
            y: end.y + (2 / 3) * (control.y - end.y),
          };
          segments.push({ type: 'bezier', control1, control2, to: end });
          current = { ...end };
          previousQuadraticControl = control;
          previousCubicControl = null;
        }
        break;
      case 'A':
        while (hasNumber()) {
          const rx = nextNumber();
          const ry = nextNumber();
          const xAxisRotation = nextNumber();
          const largeArc = nextNumber() !== 0;
          const sweep = nextNumber() !== 0;
          const ex = nextNumber();
          const ey = nextNumber();
          const end = absolute
            ? { x: ex, y: ey }
            : { x: current.x + ex, y: current.y + ey };

          const beziers = svgArcToBeziers(
            current,
            rx,
            ry,
            xAxisRotation,
            largeArc,
            sweep,
            end,
          );
          segments.push(...beziers);
          current = { ...end };
          previousCubicControl = null;
          previousQuadraticControl = null;
        }
        break;
      case 'Z':
        if (current.x !== start.x || current.y !== start.y) {
          segments.push({ type: 'line', to: { ...start } });
        }
        current = { ...start };
        if (profiles.length === 0 || segments.length > 0) {
          profiles.push({
            start: { ...start },
            segments: [...segments],
            closed: true,
          });
          segments = [];
        } else {
          profiles[profiles.length - 1].closed = true;
        }
        previousCubicControl = null;
        previousQuadraticControl = null;
        break;
      default:
        if (tokens[index] && !/[A-Za-z]/.test(tokens[index])) {
          index++;
        }
        break;
    }
  }
  finishSubpath();
  return profiles;
}
