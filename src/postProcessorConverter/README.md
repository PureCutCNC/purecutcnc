# Post-processor converter — how to run it

Converts an external CAM post-processor file into a PureCutCNC
`MachineDefinition` JSON you can review in the app's advanced
machine-definition editor. See
[`../../planning/Post_Processor_Converter_Design.md`](../../planning/Post_Processor_Converter_Design.md)
for the *why* (report contract, per-format capability, the safety
contract); this file is the *how*.

## Quick start

```bash
npm run convert-post-processor -- --input path/to/machine.pp --output my-machine.json
```

This writes two files — `my-machine.json` (the machine definition) and
`my-machine.report.json` (the machine-readable conversion report) — and
prints a human-readable version of the report to the terminal. Read the
printed report before doing anything else with the output.

> The `--` before the flags is required — it's what tells `npm run` to pass
> everything after it straight to the script instead of treating it as an
> `npm` flag.

## Flags

| Flag | Required | Description |
| --- | --- | --- |
| `--input <path>` | yes | The vendor post-processor file to convert. |
| `--output <path>` | yes | Where to write the `MachineDefinition` JSON. |
| `--format <id>` | no | Force a specific adapter instead of auto-detecting from `--input`'s extension. One of `visual-mill`, `vectric-estlcam`, `artcam`, `ecam`, `sheetcam`, `autodesk-cps`, `mastercam-pst`, or `auto` (the default). |
| `--strict` | no | Refuse to write `--output` if any finding in the report would change emitted 3-axis G-code. The report is still written either way. |
| `--force` | no | Overwrite `--output` and its report file if they already exist. Without it, a second run against the same `--output` path fails rather than silently clobbering a file you may have hand-edited. |
| `--name <string>` | no | Machine name recorded in the output (default: `--input`'s filename without its extension). |
| `--vendor <string>` | no | Optional vendor label recorded in the output. |
| `--help` | no | Print usage and exit. |

Run `npm run convert-post-processor -- --help` any time for this same list
from the source of truth (`cli.ts`'s `USAGE` constant).

## Supported formats

Format is auto-detected from `--input`'s file extension — you only need
`--format` if a file has an unusual extension for its format.

| CAM package | Extension | `--format` id |
| --- | --- | --- |
| Visual Mill | `.spm` | `visual-mill` |
| Vectric / Estlcam | `.pp` | `vectric-estlcam` |
| ArtCAM | `.con` | `artcam` |
| ECam | `.xml` | `ecam` |
| SheetCAM | `.scpost` | `sheetcam` |
| Autodesk HSM / Inventor | `.cps` | `autodesk-cps` |
| Mastercam | `.pst` | `mastercam-pst` |

## Examples

Auto-detect the format, best-effort conversion (default — writes output even
if some fields couldn't be determined, as long as they don't affect 3-axis
motion):

```bash
npm run convert-post-processor -- --input EdingCNC-MM.con --output eding-mm.json
```

Force a specific adapter (useful if a file was renamed with a non-standard
extension):

```bash
npm run convert-post-processor -- --input my-post.txt --format visual-mill --output eding.json
```

Refuse to write a definition unless every field that affects emitted 3-axis
motion was actually resolved from the source — good for a pipeline where no
one will read the report before the file gets used:

```bash
npm run convert-post-processor -- --input post.pst --output out.json --strict
```

Re-run and overwrite a previous conversion, with a custom machine name:

```bash
npm run convert-post-processor -- --input post.cps --output out.json --force --name "Shop Router (Autodesk)"
```

## Reading the report

Every finding has a `status`:

- **mapped** — carried over from the source.
- **omitted** — the source doesn't declare this; PureCutCNC's generic
  default was kept.
- **unsupported** — the source declares behavior with no PureCutCNC
  equivalent (e.g. a 4th axis, plasma/THC, a macro).
- **conflicting** — the source's own signals disagree, or PureCutCNC's
  schema can't distinguish a nuance the source has.

Findings marked `[blocks --strict]` in the printed report are the ones that
would change emitted 3-axis G-code if silently dropped — read those first.
Everything else is informational (a vendor capability with no PureCutCNC
equivalent, a formatting nuance, etc.) and doesn't need action before you use
the output.

## Next steps

1. Read the printed report (or `<output>.report.json`).
2. Open `<output>.json` in the app's advanced machine-definition editor and
   fix anything the report flagged as unresolved but relevant to your job.
3. Review the G-code this machine produces before running it — see the CNC
   safety contract in the root [`PROJECT.md`](../../PROJECT.md). A
   `--strict`-safe conversion is not a machining-safety guarantee.
