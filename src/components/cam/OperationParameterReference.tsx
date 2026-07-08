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

// All diagrams are drawn on a shared 58×34 stage and normalized to fill roughly
// x∈[6,52], y∈[5,29] so every icon carries a consistent visual weight.
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

/**
 * Small schematic reference diagram for an operation parameter, shown in the
 * third column of the operation properties panel. Mirrors the gear creation
 * reference column and reuses its `gear-reference__*` SVG element classes.
 *
 * For parameters backed by a dropdown, pass the current selection as `variant`
 * so the diagram reflects the chosen value (e.g. offset vs parallel pattern,
 * climb vs conventional cut direction).
 */
export function OperationParameterReference({
  kind,
  variant,
}: {
  kind: OperationParamRefKind
  variant?: string
}) {
  const label = operationParamRefLabel(kind)

  switch (kind) {
    case 'stepdown':
      return (
        <OpParamRefFrame label={label}>
          <path className="gear-reference__outline" d="M6 5H52V29H6Z" />
          <path className="gear-reference__guide" d="M6 13H52M6 21H52" />
          <path className="gear-reference__accent" d="M47 6V12" />
          <path className="gear-reference__accent-fill" d="M47 5l-2.4 3.3h4.8zM47 13l-2.4-3.3h4.8z" />
        </OpParamRefFrame>
      )

    case 'stepover':
      return (
        <OpParamRefFrame label={label}>
          <circle className="gear-reference__guide" cx="20" cy="17" r="10" />
          <circle className="gear-reference__outline" cx="38" cy="17" r="10" />
          <circle className="gear-reference__outline" cx="20" cy="17" r="10" />
          <path className="gear-reference__accent" d="M24 17h10" />
          <path className="gear-reference__accent-fill" d="M20 17l3.3-2.4v4.8zM38 17l-3.3-2.4v4.8z" />
        </OpParamRefFrame>
      )

    case 'maxDepth':
      return (
        <OpParamRefFrame label={label}>
          <path className="gear-reference__outline" d="M6 6H52V28H6Z" />
          <path className="gear-reference__guide" d="M6 10H52" />
          <path className="gear-reference__accent" d="M47 6v22" />
          <path className="gear-reference__accent-fill" d="M47 4l-2.6 3.6h5.2zM47 30l-2.6-3.6h5.2z" />
        </OpParamRefFrame>
      )

    case 'retractHeight':
      return (
        <OpParamRefFrame label={label}>
          <path className="gear-reference__outline" d="M6 20H52V28H6Z" />
          <path className="gear-reference__guide" d="M6 6h46" strokeDasharray="2 2" />
          <path className="gear-reference__accent" d="M47 7v12" />
          <path className="gear-reference__accent-fill" d="M47 5l-2.6 3.6h5.2zM47 20l-2.6-3.6h5.2z" />
        </OpParamRefFrame>
      )

    case 'peckDepth':
      return (
        <OpParamRefFrame label={label}>
          <path className="gear-reference__outline" d="M18 5v23M40 5v23" />
          <path className="gear-reference__guide" d="M18 5h22" />
          <path className="gear-reference__guide" d="M18 13h22M18 21h22" />
          <path className="gear-reference__accent" d="M29 6v6" />
          <path className="gear-reference__accent-fill" d="M29 5l-2.2 3h4.4zM29 13l-2.2-3h4.4z" />
        </OpParamRefFrame>
      )

    case 'feed':
      return (
        <OpParamRefFrame label={label}>
          <circle className="gear-reference__outline" cx="17" cy="17" r="9" />
          <path className="gear-reference__guide" d="M6 28h46" />
          <path className="gear-reference__accent" d="M28 17h20" />
          <path className="gear-reference__accent-fill" d="M50 17l-5-3v6z" />
        </OpParamRefFrame>
      )

    case 'plungeFeed':
      // An endmill (tool) plunging straight down into the stock.
      return (
        <OpParamRefFrame label={label}>
          <path className="gear-reference__outline" d="M6 24H52V30H6Z" />
          <path className="gear-reference__outline" d="M22 4h12v15h-12z" />
          <path className="gear-reference__guide" d="M26 6v12M30 6v12" />
          <path className="gear-reference__accent" d="M44 6v15" />
          <path className="gear-reference__accent-fill" d="M44 23l-3-5h6z" />
        </OpParamRefFrame>
      )

    case 'slotFeed':
      return (
        <OpParamRefFrame label={label}>
          <path className="gear-reference__guide" d="M6 9v16h46V9z" />
          <circle className="gear-reference__outline" cx="26" cy="17" r="8" />
          <path className="gear-reference__accent" d="M35 17h13" />
          <path className="gear-reference__accent-fill" d="M50 17l-5-3v6z" />
        </OpParamRefFrame>
      )

    case 'rpm':
      return (
        <OpParamRefFrame label={label}>
          <circle className="gear-reference__outline" cx="28" cy="17" r="11" />
          <path className="gear-reference__guide" d="M28 3v4M28 27v4M13 17h4M39 17h4" />
          <path className="gear-reference__accent" d="M37 8A13 13 0 0 1 40 23" />
          <path className="gear-reference__accent-fill" d="M41 24l-2.4-5 5 .2z" />
        </OpParamRefFrame>
      )

    case 'dwell':
      return (
        <OpParamRefFrame label={label}>
          <path className="gear-reference__outline" d="M18 5v20M38 5v20" />
          <path className="gear-reference__guide" d="M18 5h20" />
          <path className="gear-reference__accent" d="M28 6v16" />
          <path className="gear-reference__accent-fill" d="M28 24l-2.6-4.5h5.2z" />
          <circle className="gear-reference__accent" cx="46" cy="11" r="4.5" />
          <path className="gear-reference__accent" d="M46 11v-3M46 11l2.2 1.3" />
        </OpParamRefFrame>
      )

    case 'cutDirection': {
      const climb = variant === 'climb'
      return (
        <OpParamRefFrame label={label}>
          <rect className="gear-reference__outline" x="13" y="10" width="32" height="18" rx="2" />
          {climb ? (
            <>
              <path className="gear-reference__accent" d="M40 6H18" />
              <path className="gear-reference__accent-fill" d="M18 6l4.5-2.7v5.4z" />
            </>
          ) : (
            <>
              <path className="gear-reference__accent" d="M18 6h22" />
              <path className="gear-reference__accent-fill" d="M40 6l-4.5-2.7v5.4z" />
            </>
          )}
        </OpParamRefFrame>
      )
    }

    case 'pattern': {
      if (variant === 'parallel') {
        return (
          <OpParamRefFrame label={label}>
            <path className="gear-reference__outline" d="M6 5h46v24H6z" />
            <path className="gear-reference__accent" d="M11 10h36M11 17h36M11 24h36" />
            <path className="gear-reference__guide" d="M47 10v7M11 17v7" />
          </OpParamRefFrame>
        )
      }
      if (variant === 'waterline') {
        return (
          <OpParamRefFrame label={label}>
            <path className="gear-reference__outline" d="M6 5h46v24H6z" />
            <path className="gear-reference__accent" d="M29 17m-11 0a11 9 0 1 0 22 0a11 9 0 1 0-22 0" />
            <path className="gear-reference__accent" d="M29 17m-6 0a6 5 0 1 0 12 0a6 5 0 1 0-12 0" />
            <circle className="gear-reference__accent-fill" cx="29" cy="17" r="1.5" />
          </OpParamRefFrame>
        )
      }
      // offset (default)
      return (
        <OpParamRefFrame label={label}>
          <path className="gear-reference__outline" d="M6 5h46v24H6z" />
          <path className="gear-reference__accent" d="M12 10h34v14H12z" />
          <path className="gear-reference__guide" d="M20 15h18v4H20z" />
        </OpParamRefFrame>
      )
    }

    case 'machiningOrder': {
      const featureFirst = variant === 'feature_first'
      return (
        <OpParamRefFrame label={label}>
          <path className="gear-reference__guide" d="M8 6h19v22H8zM31 6h19v22H31z" />
          <path className="gear-reference__guide" d="M8 17h19M31 17h19" />
          {featureFirst ? (
            <>
              <path className="gear-reference__accent" d="M17 9v9" />
              <path className="gear-reference__accent-fill" d="M17 20l-2.4-4.2h4.8z" />
              <path className="gear-reference__accent" d="M28 13h5" />
              <path className="gear-reference__accent-fill" d="M34 13l-3.5-2.2v4.4z" />
            </>
          ) : (
            <>
              <path className="gear-reference__accent" d="M11 12h27" />
              <path className="gear-reference__accent-fill" d="M41 12l-3.5-2.2v4.4z" />
              <path className="gear-reference__accent" d="M11 22h27" />
              <path className="gear-reference__accent-fill" d="M41 22l-3.5-2.2v4.4z" />
            </>
          )}
        </OpParamRefFrame>
      )
    }

    case 'rasterAngle':
      return (
        <OpParamRefFrame label={label}>
          <path className="gear-reference__outline" d="M6 5h46v24H6z" />
          <path className="gear-reference__guide" d="M6 17h46" />
          <path className="gear-reference__accent" d="M13 27l17-21M22 27l17-21M31 27l17-21" />
          <path className="gear-reference__accent-fill" d="M46 8l-1.6-2.6 3.1-.5z" />
        </OpParamRefFrame>
      )

    case 'finishWalls':
      return (
        <OpParamRefFrame label={label}>
          <path className="gear-reference__guide" d="M6 6h46v22H6z" />
          <path className="gear-reference__guide" d="M9 17h40" />
          <path className="gear-reference__accent" d="M6 6v22M52 6v22" />
        </OpParamRefFrame>
      )

    case 'finishFloor':
      return (
        <OpParamRefFrame label={label}>
          <path className="gear-reference__guide" d="M6 6h46v22H6z" />
          <path className="gear-reference__guide" d="M6 9v16M52 9v16" />
          <path className="gear-reference__accent" d="M8 28h44" />
        </OpParamRefFrame>
      )

    case 'stockRadial':
      return (
        <OpParamRefFrame label={label}>
          <path className="gear-reference__guide" d="M8 7h42v20H8z" />
          <path className="gear-reference__outline" d="M14 12h24v10H14z" />
          <path className="gear-reference__accent" d="M39 17h10" />
          <path className="gear-reference__accent-fill" d="M38 17l3-2.2v4.4zM50 17l-3-2.2v4.4z" />
        </OpParamRefFrame>
      )

    case 'stockAxial':
      return (
        <OpParamRefFrame label={label}>
          <path className="gear-reference__outline" d="M6 5H52V29H6Z" />
          <path className="gear-reference__guide" d="M6 22H52" />
          <path className="gear-reference__accent" d="M10 25.5h34" />
          <path className="gear-reference__accent" d="M47 22v7" />
          <path className="gear-reference__accent-fill" d="M47 22l-2 3h4zM47 29l-2-3h4z" />
        </OpParamRefFrame>
      )

    case 'adaptiveSpacing':
      return (
        <OpParamRefFrame label={label}>
          <path className="gear-reference__guide" d="M29 17m-11 0a11 10 0 1 0 22 0a11 10 0 1 0-22 0" />
          <path className="gear-reference__outline" d="M29 17m-7 0a7 6 0 1 0 14 0a7 6 0 1 0-14 0" />
          <path className="gear-reference__guide" d="M29 17m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0" />
          <path className="gear-reference__accent" d="M31 5v7" />
          <path className="gear-reference__accent-fill" d="M31 4l-2.2 3h4.4zM31 13l-2.2-3h4.4z" />
        </OpParamRefFrame>
      )

    case 'adaptiveRefinement':
      return (
        <OpParamRefFrame label={label}>
          <path className="gear-reference__guide" d="M6 29L29 6L52 29" />
          <path className="gear-reference__guide" d="M6 29h46" />
          <path className="gear-reference__accent" d="M12 29l4.5-6.5M17 29l4-6.5M22 29l4.5-6.5M27 29l4-6.5" />
          <path className="gear-reference__accent" d="M31 29l4-6.5M36 29l4.5-6.5M41 29l4-6.5M46 29l4.5-6.5" />
        </OpParamRefFrame>
      )

    case 'maxRings':
      return (
        <OpParamRefFrame label={label}>
          <path className="gear-reference__guide" d="M29 17m-12 0a12 11 0 1 0 24 0a12 11 0 1 0-24 0" />
          <path className="gear-reference__guide" d="M29 17m-7.5 0a7.5 6.5 0 1 0 15 0a7.5 6.5 0 1 0-15 0" />
          <path className="gear-reference__guide" d="M29 17m-3 0a3 2.5 0 1 0 6 0a3 2.5 0 1 0-6 0" />
          <path className="gear-reference__accent" d="M21 6c-3.5 3-3.5 19 0 22" />
          <path className="gear-reference__accent" d="M37 6c3.5 3 3.5 19 0 22" />
          <path className="gear-reference__accent-fill" d="M21 5l-2.6 3.6h5.2z" />
        </OpParamRefFrame>
      )

    case 'drillType': {
      const hole = (
        <>
          <path className="gear-reference__outline" d="M18 4v24M40 4v24" />
          <path className="gear-reference__guide" d="M18 4h22" />
        </>
      )
      if (variant === 'peck') {
        return (
          <OpParamRefFrame label={label}>
            {hole}
            <path className="gear-reference__accent" d="M29 5v5M29 12v5M29 19v4" />
            <path className="gear-reference__accent-fill" d="M29 26l-2.6-4.5h5.2z" />
          </OpParamRefFrame>
        )
      }
      if (variant === 'chip_breaking') {
        return (
          <OpParamRefFrame label={label}>
            {hole}
            <path className="gear-reference__accent" d="M29 5v4M29 11v3M29 16v3M29 21v3" />
            <path className="gear-reference__accent-fill" d="M29 26l-2.6-4.5h5.2z" />
          </OpParamRefFrame>
        )
      }
      if (variant === 'dwell') {
        return (
          <OpParamRefFrame label={label}>
            {hole}
            <path className="gear-reference__accent" d="M29 5v16" />
            <path className="gear-reference__accent-fill" d="M29 26l-2.6-4.5h5.2z" />
            <circle className="gear-reference__accent" cx="46" cy="10" r="4.5" />
            <path className="gear-reference__accent" d="M46 10v-3M46 10l2.2 1.3" />
          </OpParamRefFrame>
        )
      }
      // simple (default)
      return (
        <OpParamRefFrame label={label}>
          {hole}
          <path className="gear-reference__accent" d="M29 5v16" />
          <path className="gear-reference__accent-fill" d="M29 26l-2.6-4.5h5.2z" />
        </OpParamRefFrame>
      )
    }
  }
}
