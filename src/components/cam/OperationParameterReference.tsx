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

import type { ReactNode } from 'react'
import { type OperationParamRefKind, operationParamRefLabel } from './operationParamRefData'

function OpParamRefFrame({
  children,
  label,
}: {
  children: ReactNode
  label: string
}) {
  return (
    <svg
      className="op-param-ref"
      viewBox="0 0 58 34"
      role="img"
      aria-label={label}
      focusable="false"
    >
      {children}
    </svg>
  )
}

export function OperationParameterReference({ kind }: { kind: OperationParamRefKind }) {
  const label = operationParamRefLabel(kind)

  switch (kind) {
    case 'stepdown':
      return (
        <OpParamRefFrame label={label}>
          <path className="gear-reference__outline" d="M10 6H48V28H10Z" />
          <path className="gear-reference__guide" d="M10 13H48M10 20H48" />
          <path className="gear-reference__accent" d="M44 7V12" />
          <path className="gear-reference__accent-fill" d="M44 6l-2.2 3h4.4zM44 13l-2.2-3h4.4z" />
        </OpParamRefFrame>
      )

    case 'stepover':
      return (
        <OpParamRefFrame label={label}>
          <circle className="gear-reference__guide" cx="18" cy="17" r="6" />
          <circle className="gear-reference__outline" cx="32" cy="17" r="6" />
          <circle className="gear-reference__outline" cx="18" cy="17" r="6" />
          <path className="gear-reference__accent" d="M24 17h8" />
          <path className="gear-reference__accent-fill" d="M23 17l3-2.2v4.4zM33 17l-3-2.2v4.4z" />
        </OpParamRefFrame>
      )

    case 'maxDepth':
      return (
        <OpParamRefFrame label={label}>
          <path className="gear-reference__outline" d="M10 6H48V28H10Z" />
          <path className="gear-reference__guide" d="M10 10H48" />
          <path className="gear-reference__accent" d="M44 6v22" />
          <path className="gear-reference__accent-fill" d="M44 4l-2.5 3.5h5zM44 30l-2.5-3.5h5z" />
        </OpParamRefFrame>
      )

    case 'retractHeight':
      return (
        <OpParamRefFrame label={label}>
          <path className="gear-reference__outline" d="M10 18H48V28H10Z" />
          <path className="gear-reference__guide" d="M10 6h38" strokeDasharray="2 2" />
          <path className="gear-reference__accent" d="M44 7v11" />
          <path className="gear-reference__accent-fill" d="M44 5l-2.5 3.5h5zM44 19l-2.5-3.5h5z" />
        </OpParamRefFrame>
      )

    case 'peckDepth':
      return (
        <OpParamRefFrame label={label}>
          <path className="gear-reference__outline" d="M24 4v26h-4V4h4zM25 30h-6v-2h6zM25 4h-6V2h6z" />
          <path className="gear-reference__guide" d="M40 5h8M40 11h8M40 17h8M40 23h8" />
          <path className="gear-reference__accent" d="M44 18v5" />
          <path className="gear-reference__accent-fill" d="M44 17l-2.2 3h4.4zM44 24l-2.2-3h4.4z" />
        </OpParamRefFrame>
      )

    case 'feed':
      return (
        <OpParamRefFrame label={label}>
          <circle className="gear-reference__outline" cx="20" cy="17" r="7" />
          <path className="gear-reference__guide" d="M10 27h38" />
          <path className="gear-reference__accent" d="M27 17h15" />
          <path className="gear-reference__accent-fill" d="M43 17l-4.5-2.6v5.2z" />
        </OpParamRefFrame>
      )

    case 'plungeFeed':
      return (
        <OpParamRefFrame label={label}>
          <path className="gear-reference__outline" d="M10 22H48V28H10Z" />
          <circle className="gear-reference__guide" cx="29" cy="12" r="5" />
          <path className="gear-reference__guide" d="M25 17h8" />
          <path className="gear-reference__accent" d="M29 17v5" />
          <path className="gear-reference__accent-fill" d="M29 23l-2.6-4.5h5.2z" />
        </OpParamRefFrame>
      )

    case 'slotFeed':
      return (
        <OpParamRefFrame label={label}>
          <path className="gear-reference__guide" d="M10 12v10h38V12z" />
          <circle className="gear-reference__outline" cx="29" cy="17" r="6" />
          <path className="gear-reference__accent" d="M37 17h7" />
          <path className="gear-reference__accent-fill" d="M45 17l-4.5-2.6v5.2z" />
        </OpParamRefFrame>
      )

    case 'rpm':
      return (
        <OpParamRefFrame label={label}>
          <circle className="gear-reference__outline" cx="29" cy="17" r="9" />
          <path className="gear-reference__guide" d="M29 2v5M29 27v5M11 17h5M42 17h5" />
          <path className="gear-reference__accent" d="M35 10A12 12 0 0 1 38 22" />
          <path className="gear-reference__accent-fill" d="M39 23l-2.5-4.8 5 .5z" />
        </OpParamRefFrame>
      )

    case 'dwell':
      return (
        <OpParamRefFrame label={label}>
          <path className="gear-reference__outline" d="M24 4v10h-4V4h4zM25 14h-6v-2h6zM25 4h-6V2h6z" />
          <path className="gear-reference__guide" d="M10 28h38" />
          <path className="gear-reference__accent" d="M33 14A6 6 0 0 1 44 14" />
          <path className="gear-reference__accent-fill" d="M33 14l-2.5 5 5-.5z" />
          <circle className="gear-reference__accent-fill" cx="44" cy="14" r="1.5" />
        </OpParamRefFrame>
      )

    case 'cutDirection':
      return (
        <OpParamRefFrame label={label}>
          <path className="gear-reference__outline" d="M12 10h34v14H12z" />
          <path className="gear-reference__accent" d="M18 24h22" />
          <path className="gear-reference__accent-fill" d="M41 24l-4.5-2.6v5.2z" />
          <path className="gear-reference__guide" d="M28 17v-3a4 4 0 0 0-3-4" />
        </OpParamRefFrame>
      )

    case 'pattern':
      return (
        <OpParamRefFrame label={label}>
          <path className="gear-reference__outline" d="M10 6h38v22H10z" />
          <path className="gear-reference__accent" d="M29 17m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0" />
          <path className="gear-reference__guide" d="M29 17m-8 0a8 8 0 1 0 16 0a8 8 0 1 0-16 0" />
        </OpParamRefFrame>
      )

    case 'machiningOrder':
      return (
        <OpParamRefFrame label={label}>
          <path className="gear-reference__guide" d="M14 10h10v14H14zM24 10h10v14H24zM34 10h10v14H34z" />
          <path className="gear-reference__accent" d="M19 17l5-3v6zM25 13l5 3-5 3" />
          <path className="gear-reference__accent-fill" d="M31 11l-2.5 3.5h5z" />
        </OpParamRefFrame>
      )

    case 'rasterAngle':
      return (
        <OpParamRefFrame label={label}>
          <path className="gear-reference__outline" d="M10 6h38v22H10z" />
          <path className="gear-reference__guide" d="M10 17h38" />
          <path className="gear-reference__accent" d="M18 25l14-16M23 25l14-16M28 25l14-16" />
          <path className="gear-reference__accent-fill" d="M39 20l-1-2 2-.5z" />
        </OpParamRefFrame>
      )

    case 'finishWalls':
      return (
        <OpParamRefFrame label={label}>
          <path className="gear-reference__outline" d="M10 8h38v18H10z" />
          <path className="gear-reference__guide" d="M12 17h34" />
          <path className="gear-reference__accent" d="M10 8v18M48 8v18" />
          <path className="gear-reference__accent" d="M10 8h38M10 26h38" />
        </OpParamRefFrame>
      )

    case 'finishFloor':
      return (
        <OpParamRefFrame label={label}>
          <path className="gear-reference__outline" d="M10 8h38v18H10z" />
          <path className="gear-reference__guide" d="M10 10v14M48 10v14" />
          <path className="gear-reference__accent" d="M12 26h34" />
          <path className="gear-reference__accent" d="M12 8h34" />
        </OpParamRefFrame>
      )

    case 'stockRadial':
      return (
        <OpParamRefFrame label={label}>
          <path className="gear-reference__guide" d="M14 10h30v14H14z" />
          <path className="gear-reference__outline" d="M18 14h22v6H18z" />
          <path className="gear-reference__accent" d="M40 17h5" />
          <path className="gear-reference__accent-fill" d="M39 17l3-2.2v4.4zM46 17l-3-2.2v4.4z" />
        </OpParamRefFrame>
      )

    case 'stockAxial':
      return (
        <OpParamRefFrame label={label}>
          <path className="gear-reference__outline" d="M10 6H48V28H10Z" />
          <path className="gear-reference__guide" d="M10 22h38" />
          <path className="gear-reference__accent" d="M12 22h36" />
          <path className="gear-reference__accent-fill" d="M44 22l-2.2 3h4.4zM44 28l-2.2-3h4.4z" />
          <path className="gear-reference__guide" d="M44 23v4" />
        </OpParamRefFrame>
      )

    case 'adaptiveSpacing':
      return (
        <OpParamRefFrame label={label}>
          <path className="gear-reference__guide" d="M29 17m-6 0a6 6 0 1 0 12 0a6 6 0 1 0-12 0" />
          <path className="gear-reference__guide" d="M29 17m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0" />
          <path className="gear-reference__outline" d="M29 17m-4 0a4 4 0 1 0 8 0a4 4 0 1 0-8 0" />
          <path className="gear-reference__accent" d="M31 13v3" />
          <path className="gear-reference__accent-fill" d="M31 12l-2.2 3h4.4zM31 17l-2.2-3h4.4z" />
        </OpParamRefFrame>
      )

    case 'adaptiveRefinement':
      return (
        <OpParamRefFrame label={label}>
          <path className="gear-reference__guide" d="M10 26L29 8L48 26" />
          <path className="gear-reference__outline" d="M29 8l4 4.5M25 8l3 4.5M21 8l4.5 4.5M33 8l2.5 4.5M17 8l4 4.5" />
          <path className="gear-reference__guide" d="M10 26h38" />
          <path className="gear-reference__accent" d="M14 26l3-4.5M18 26l2.5-4.5M22 26l3-4.5M26 26l2.5-4.5" />
          <path className="gear-reference__accent" d="M30 26l2-4M34 26l2.5-4M38 26l3-4M42 26l2.5-4" />
        </OpParamRefFrame>
      )

    case 'maxRings':
      return (
        <OpParamRefFrame label={label}>
          <path className="gear-reference__guide" d="M29 17m-9 0a9 9 0 1 0 18 0a9 9 0 1 0-18 0" />
          <path className="gear-reference__guide" d="M29 17m-5 0a5 5 0 1 0 10 0a5 5 0 1 0-10 0" />
          <path className="gear-reference__guide" d="M29 17m-1 0a1 1 0 1 0 2 0a1 1 0 1 0-2 0" />
          <path className="gear-reference__accent" d="M24 10c-2.5 2.5-2.5 8 0 12" />
          <path className="gear-reference__accent" d="M34 10c2.5 2.5 2.5 8 0 12" />
          <path className="gear-reference__accent-fill" d="M24 9l-2.5 3.5h5z" />
        </OpParamRefFrame>
      )

    case 'drillType':
      return (
        <OpParamRefFrame label={label}>
          <path className="gear-reference__outline" d="M25 2h8v12h-8z" />
          <path className="gear-reference__guide" d="M25 14l-4 8h16l-4-8" />
          <path className="gear-reference__guide" d="M29 14v6" />
          <path className="gear-reference__accent" d="M27 3v10M31 3v10" />
          <path className="gear-reference__accent-fill" d="M29 22l-2.5-5h5z" />
        </OpParamRefFrame>
      )
  }
}
