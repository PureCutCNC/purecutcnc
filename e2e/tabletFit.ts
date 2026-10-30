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
 * The fit half of the tablet pass over #1112: can a surface really be seen on a
 * tablet, or only does its own box happen to be inside the window?
 *
 * `tabletFitReport` runs **in the page** (`locator.evaluate(tabletFitReport, …)`)
 * so it reads the real computed styles and layout. It answers each axis
 * separately, because a vertical drawer that scrolls must never excuse a panel
 * clipped at the side.
 *
 * The false passes it exists to refuse (Codex review of #1112 rt4-a fix1 and
 * fix2):
 *
 *  - a surface whose own box fits the viewport but is cut by an
 *    `overflow: hidden` ancestor — the early "inside the viewport" return used
 *    to skip the ancestor walk entirely;
 *  - a surface wider than the scroller that is supposed to show it — scrolling
 *    a 900px surface inside a 200px port can never show it whole, however far
 *    the port scrolls;
 *  - a surface painted past the edge of the window with nothing left to scroll
 *    it back — the ancestor walk can end with no clipping ancestor at all (a
 *    shadow host, a plain document), and ending the walk is not proof the
 *    surface is visible (#1112 rt4-a fix3 review F1).
 *
 * It stays dependency-free and self-contained: Playwright serialises the
 * function source into the page, so it may not reference module scope.
 */

/** The viewport a surface has to fit. */
export interface TabletViewport {
  width: number
  height: number
}

/** Which axis a finding is about. */
export type FitAxis = 'x' | 'y'

/**
 * Why an axis cannot show the surface:
 *  - `clipped-hidden`: an ancestor with `overflow: hidden|clip` cuts it and
 *    nothing can scroll it back.
 *  - `too-wide-for-scroller`: on the horizontal axis the surface is wider than
 *    its scroll port, so no scroll position shows it whole.
 *  - `outside-scroll-range`: the nearest scroller cannot reach far enough.
 *  - `scroller-off-screen`: the scroller itself lies outside the viewport.
 *  - `outside-viewport`: after every clipping ancestor, what can be shown is
 *    still painted past the window edge, and no scrolling ancestor is left.
 */
export type FitReason =
  | 'clipped-hidden'
  | 'too-wide-for-scroller'
  | 'outside-scroll-range'
  | 'scroller-off-screen'
  | 'outside-viewport'

/** One reason an axis cannot fully show the surface. */
export interface FitIssue {
  axis: FitAxis
  reason: FitReason
  /** Human-readable description, used verbatim in the assertion message. */
  detail: string
}

/** The answer for one axis. */
export interface AxisFit {
  axis: FitAxis
  /** The surface's own box is inside the viewport on this axis. */
  withinViewport: boolean
  /** Empty when the axis is fine; otherwise why not. */
  issues: FitIssue[]
}

/** Both axes, computed independently. */
export interface TabletFitReport {
  horizontal: AxisFit
  vertical: AxisFit
}

/**
 * Measure `element` against `viewport` and report anything that stops the whole
 * surface being seen: an ancestor clipping it, a scroll port that cannot show it
 * in full sideways, a scroller that cannot reach it, or — when the ancestor walk
 * finds no clipping ancestor at all — a surface simply painted past the window
 * edge.
 *
 * A vertical scroller is allowed to be shorter than the surface — "scrolling
 * inside the panel is fine if it scrolls", per the handoff — but it must be
 * able to carry the surface from its first pixel to its last. A horizontal port
 * must be able to show the whole width at once: sideways scrolling on a tablet
 * is the failure, not the remedy.
 *
 * Call it through `locator.evaluate(tabletFitReport, viewport)`; the function is
 * self-contained so Playwright can serialise it into the page.
 */
export function tabletFitReport(element: Element, viewport: TabletViewport): TabletFitReport {
  /** Layout rounding slack, in CSS px. */
  const EPSILON = 0.5
  const round = (value: number): number => Math.round(value)

  function describeNode(node: Element): string {
    const classes = typeof node.className === 'string'
      ? node.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.')
      : ''
    return `<${node.tagName.toLowerCase()}${classes ? ` class="${classes}"` : ''}>`
  }

  function axisReport(axis: FitAxis): AxisFit {
    const box = element.getBoundingClientRect()
    const limit = axis === 'x' ? viewport.width : viewport.height
    const start = axis === 'x' ? box.left : box.top
    const end = axis === 'x' ? box.right : box.bottom
    const withinViewport = start >= -EPSILON && end <= limit + EPSILON
    const issues: FitIssue[] = []
    // What has to fit from here up. The surface itself until a scroll container
    // can move it; after that, the container's own port — a scroll offset moves
    // the surface within the port, not the port within its ancestors.
    let subjectStart = start
    let subjectEnd = end
    let node: Element | null = element.parentElement
    while (node) {
      const style = getComputedStyle(node)
      const overflow = axis === 'x' ? style.overflowX : style.overflowY
      if (overflow !== 'hidden' && overflow !== 'clip' && overflow !== 'auto' && overflow !== 'scroll') {
        node = node.parentElement
        continue
      }
      const rect = node.getBoundingClientRect()
      // `overflow` clips at the padding box: the client area, inside the border.
      const clipStart = (axis === 'x' ? rect.left : rect.top)
        + (axis === 'x' ? node.clientLeft : node.clientTop)
      const clientSize = axis === 'x' ? node.clientWidth : node.clientHeight
      const clipEnd = clipStart + clientSize
      if (subjectStart >= clipStart - EPSILON && subjectEnd <= clipEnd + EPSILON) {
        // This ancestor does not cut the surface; a higher one still may.
        node = node.parentElement
        continue
      }
      if (overflow === 'hidden' || overflow === 'clip') {
        issues.push({
          axis,
          reason: 'clipped-hidden',
          detail: `${axis === 'x' ? 'sideways' : 'vertically'}: clipped by ${describeNode(node)}, `
            + `whose box covers ${round(clipStart)}–${round(clipEnd)} while the surface spans `
            + `${round(subjectStart)}–${round(subjectEnd)}`,
        })
        return { axis, withinViewport, issues }
      }
      const scrollSize = axis === 'x' ? node.scrollWidth : node.scrollHeight
      const maxScroll = scrollSize - clientSize
      const scroll = axis === 'x' ? node.scrollLeft : node.scrollTop
      const needed = subjectEnd > clipEnd
        ? subjectEnd - clipEnd + scroll
        : subjectStart < clipStart
          ? subjectStart - clipStart + scroll
          : 0
      const subjectSize = subjectEnd - subjectStart
      if (axis === 'x' && subjectSize > clientSize + EPSILON) {
        issues.push({
          axis,
          reason: 'too-wide-for-scroller',
          detail: `sideways: the surface is ${round(subjectSize)}px wide and its scroller `
            + `${describeNode(node)} can only show ${round(clientSize)}px at once`,
        })
        return { axis, withinViewport, issues }
      }
      if (needed < -EPSILON || needed > maxScroll + EPSILON) {
        issues.push({
          axis,
          reason: 'outside-scroll-range',
          detail: `${axis === 'x' ? 'sideways: ' : ''}needs ${round(needed)}px of scrolling from `
            + `${describeNode(node)}, which has ${round(maxScroll)}px`,
        })
        return { axis, withinViewport, issues }
      }
      if (clipStart < -EPSILON || clipEnd > limit + EPSILON) {
        issues.push({
          axis,
          reason: 'scroller-off-screen',
          detail: `${axis === 'x' ? 'sideways: ' : ''}its scroller ${describeNode(node)} spans `
            + `${round(clipStart)}–${round(clipEnd)}, outside the ${round(limit)}px `
            + `${axis === 'x' ? 'viewport width' : 'viewport height'}`,
        })
        return { axis, withinViewport, issues }
      }
      subjectStart = Math.max(subjectStart, clipStart)
      subjectEnd = Math.min(subjectEnd, clipEnd)
      node = node.parentElement
    }
    // Nothing above can move it any further: whatever is still outside the
    // window is unreachable, so the walk ending is not a pass. This is the
    // check the ancestor walk must not replace: with no clipping ancestor (a
    // shadow host, a plain document) an off-screen surface used to come back
    // with an empty `issues` array and pass the assertion (#1112 rt4-a fix3
    // review F1).
    if (subjectStart < -EPSILON || subjectEnd > limit + EPSILON) {
      issues.push({
        axis,
        reason: 'outside-viewport',
        detail: `${axis === 'x' ? 'sideways' : 'vertically'}: what can be shown spans `
          + `${round(subjectStart)}–${round(subjectEnd)} in a ${round(limit)}px `
          + `${axis === 'x' ? 'viewport width' : 'viewport height'}, `
          + 'with no scrolling ancestor left to bring it in',
      })
    }
    return { axis, withinViewport, issues }
  }

  return { horizontal: axisReport('x'), vertical: axisReport('y') }
}
