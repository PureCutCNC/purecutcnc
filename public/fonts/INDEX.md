# INDEX — public/fonts/

Runtime font assets that are fetched only by their owning feature rather than
included in the initial application JavaScript.

- `noto-sans-sc-booklet.ttf` — 500,752-byte Noto Sans SC Regular subset,
  containing the shipped Simplified Chinese catalog plus Latin extensions and
  punctuation. It is fetched only for booklets that contain text outside
  Helvetica's WinAnsi coverage, then embedded directly in the PDF.
- `noto-sans-sc-booklet-bold.ttf` — 298,720-byte matching Bold subset. It is
  fetched with the regular asset so Chinese booklet headings and labels retain
  the same weight hierarchy as the Helvetica path.
- `NotoSansSC-LICENSE.txt` — SIL Open Font License 1.1 for the bundled font.
