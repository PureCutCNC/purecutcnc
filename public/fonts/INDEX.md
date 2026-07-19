# INDEX — public/fonts/

Runtime font assets that are fetched only by their owning feature rather than
included in the initial application JavaScript.

- `noto-sans-sc-booklet.ttf` — 500,752-byte Noto Sans SC Regular subset,
  containing the shipped Simplified Chinese catalog plus Latin extensions and
  punctuation. It is fetched only for booklets that contain text outside
  Helvetica's WinAnsi coverage, then embedded directly in the PDF.
- `NotoSansSC-LICENSE.txt` — SIL Open Font License 1.1 for the bundled font.
