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
 * Print a self-contained HTML document without touching the app UI.
 *
 * Uses a hidden same-origin iframe created synchronously from the user
 * action, so popup blockers never get involved and the main document's
 * layout/styles play no part in the output. Shared by browser and Tauri —
 * both print through the WebView's own print pipeline.
 */

const CLEANUP_FALLBACK_MS = 60_000
const SVG_IMAGE_LOAD_CAP_MS = 1_500

/**
 * Wait for an SVG `<image>` element (e.g. the printed backdrop) to finish
 * loading. Prefers decode() where available; otherwise resolves on
 * load/error with a time cap, since SVGImageElement has no `complete` flag
 * and the events may have fired before the listeners attached.
 */
function waitForSvgImage(image: SVGImageElement): Promise<void> {
  const decodable = image as SVGImageElement & { decode?: () => Promise<void> }
  if (typeof decodable.decode === 'function') {
    return decodable.decode().catch(() => undefined)
  }
  return new Promise((resolve) => {
    const done = () => resolve()
    image.addEventListener('load', done, { once: true })
    image.addEventListener('error', done, { once: true })
    window.setTimeout(done, SVG_IMAGE_LOAD_CAP_MS)
  })
}

/**
 * Render `html` into a hidden iframe and open the print dialog for it.
 * Resolves once printing has been requested; the iframe is removed after
 * `afterprint` (or a fallback timeout, since some WebViews never fire it).
 */
export async function printHtmlDocument(html: string): Promise<void> {
  const iframe = document.createElement('iframe')
  iframe.setAttribute('title', 'Print document')
  iframe.setAttribute('aria-hidden', 'true')
  iframe.style.cssText = 'position: fixed; right: 0; bottom: 0; width: 0; height: 0; border: 0; visibility: hidden;'
  document.body.appendChild(iframe)

  const remove = () => {
    if (iframe.parentNode) iframe.parentNode.removeChild(iframe)
  }

  try {
    const doc = iframe.contentDocument
    const win = iframe.contentWindow
    if (!doc || !win) {
      throw new Error('Unable to create a print frame.')
    }

    doc.open()
    doc.write(html)
    doc.close()

    // Wait for embedded images so the print snapshot is complete. The
    // design document embeds its rasters (backdrop, model top views) as SVG
    // <image> elements, which document.images does NOT include — wait for
    // both kinds. decode() failures are non-fatal.
    await Promise.all([
      ...Array.from(doc.images).map((img) =>
        img.decode ? img.decode().catch(() => undefined) : Promise.resolve(undefined),
      ),
      ...Array.from(doc.querySelectorAll('image')).map((image) => waitForSvgImage(image)),
    ])

    let cleanedUp = false
    const cleanup = () => {
      if (cleanedUp) return
      cleanedUp = true
      remove()
    }
    win.addEventListener('afterprint', () => window.setTimeout(cleanup, 250))
    window.setTimeout(cleanup, CLEANUP_FALLBACK_MS)

    win.focus()
    win.print()
  } catch (error) {
    remove()
    throw error
  }
}
