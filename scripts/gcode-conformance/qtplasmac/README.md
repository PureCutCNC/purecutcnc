# QtPlasmaC simulator check

Runs plasma programs through **LinuxCNC's own QtPlasmaC simulator
configuration** in a container (issue #954).

Nobody on the project owns a plasma table. Until a tester runs files on a real
one, this is the only evidence that our plasma output is something QtPlasmaC
accepts — so it has to be green before the plasma post output (#959) merges.

## Running

```bash
npm run check:gcode:qtplasmac
npm run check:gcode:qtplasmac -- --only single-outline
```

It needs Podman or Docker, nothing else; the first run builds the image. With
no working container runtime the command says plainly that nothing was verified
and exits 0, like the validators of `npm run check:gcode`. CI sets
`QTPLASMAC_SIM_REQUIRED=1`, which turns that skip into a failure.
`QTPLASMAC_SIM_RUNTIME=docker` forces a runtime.

The verdict rules have their own unit test (`verdict.test.ts`), which runs first
and needs no container.

## What a program goes through

The same three things that happen when an operator opens a file in QtPlasmaC
and presses Cycle Start:

1. **QtPlasmaC's load filter**, `qtplasmac_gcode`. This is where QtPlasmaC's
   plasma rules live — a material that is not in the material file, an M3 before
   any movement, a material change under cutter compensation. Its dialog is
   captured instead of shown (`sim/filter_capture.py`); the filter itself is
   unmodified.
2. **The interpreter pass every LinuxCNC GUI makes on load.** A syntax error
   surfaces here with its line number.
3. **A real run** under LinuxCNC's task controller with the QtPlasmaC GUI, the
   `plasmac` HAL component and the simulated torch live. `M190` is executed by
   QtPlasmaC's own `M190` script, and `M3 $0 S1` really probes, pierces and
   waits for arc-OK. A realtime sampler records the torch, motion and feed
   signals on every servo period (1 kHz), so no move is too short to be seen.

`verdict.ts` then applies the rules:

| rule | a program fails it when |
|---|---|
| `load` | QtPlasmaC's load filter reports an error or a warning |
| `interpreter` | the interpreter rejects a line, or the run raises an error |
| `completion` | the run times out, stops before the program's last move, or ends with the torch on |
| `torch` | a feed or arc move travels while `plasmac.torch-on` is off — or the program never cuts at all |
| `material` | the torch fires while QtPlasmaC still has its default material loaded |
| `material-wait` | a material select is not followed by `M66 P3 L3 Qn` and then the feed word, before the next torch-on |
| `feed` | a cut runs at an F word other than the loaded material's cut feed |
| `trace` | the sampler dropped samples; nothing is proven and the check fails |

The `material` rule works by resetting QtPlasmaC to material 0 before every run
(after the filter, which pre-selects the program's first material on load).
Material 0 is therefore reserved: a program must select material 1 or 2
(`sim/materials-*.cfg`).

`material-wait` and `feed` are the cause and the effect of the same mistake.
The manual requires `M190 Pn`, then `M66 P3 L3 Qn`, then the feed word, in that
order. The interpreter reads ahead, so a feed word that is not behind the wait
is evaluated before the material change has happened: the material changes, but
the cut runs at the previous material's feed. The simulator shows exactly that —
with the wait removed or moved after the feed word, material 1 (cut feed 5000)
is cut at 4000, the default material's feed. `material-wait` reads the order off
the program as QtPlasmaC's filter rewrote it, for every material change; `feed`
compares the F word in effect with `plasmac.cut-feed-rate` on every cutting
sample. The sequence rule is needed as well as the measurement because two
materials can share a feed, and a successful run on the sim's small material
file says nothing about the handshake on a large one.

The feed is sampled from `motion.feed-mm-per-minute` (or `-inches-`), so a G20
program on a metric machine compares in machine units, with
`plasmac.adaptive-feed` divided out so QtPlasmaC's own velocity reduction
(`M67 E3 Qn`, used for small holes) does not read as a wrong feed.

## Why the full simulator, not `rs274`

The issue's open question was whether LinuxCNC's standalone `rs274`
interpreter — which `npm run check:gcode` already runs — could load QtPlasmaC's
M-codes through the sim's ini. **It cannot**, verified in a container and in
LinuxCNC's source:

- `rs274 -i <qtplasmac ini> -g program.ngc` stops at `M190 P1` with
  `Unknown m code used: M190`. User M-codes (`M100`–`M199`) are registered by
  the task controller (`emcTaskInit` in `src/emc/task/emctask.cc` scans
  `USER_M_PATH`), not by the interpreter; `rs274` never runs that code.
- `F#<_hal[plasmac.cut-feed-rate]>`, the documented way to take the feed rate
  from the material, fails with `Named parameter … not defined`: it reads a
  live HAL pin, and standalone `rs274` has no HAL.
- QtPlasmaC's `M190` is a script that talks to pins owned by the QtPlasmaC GUI
  (`qtplasmac.material_change`, `qtplasmac.material_change_number`). Without
  the GUI there is nothing for it to talk to.

Stubbing those three would leave an interpreter pass that checks none of what
is specific to QtPlasmaC, so the check runs the real thing. It turned out to run
headless without trouble: `linuxcnc` under Xvfb, driven through LinuxCNC's
Python API (`sim/driver.py`). The one container setting it needs is
`--cap-add=IPC_OWNER`, because LinuxCNC's realtime helper and its GUI processes
run as different users and share SysV memory.

## Pinned version

**LinuxCNC 2.9.10** (`linuxcnc-uspace=1:2.9.10` from linuxcnc.org's bookworm
archive), which carries **QtPlasmaC v238.315**.

Debian's own `linuxcnc-uspace` — what the `rs274` CI job installs — is a 2.9.0
pre-release snapshot from February 2023. QtPlasmaC changed a good deal through
the 2.9.x releases (the load filter was rewritten, and the default material stopped
being a built-in material 0), and the releases are what a plasma table runs, so this check does
not share that package. linuxcnc.org keeps every release in its archive, so the
exact version stays installable. The simulator reports the version it ran and
`run.ts` fails if it is not the pinned one.

To move the pin, change `LINUXCNC_VERSION` in `Containerfile` and
`PINNED_LINUXCNC_VERSION` in `run.ts` together, and rerun.

The archive's signing key (`sim/linuxcnc-archive-key.asc`, the 2008 "EMC
Archive Signing Key" that signs the bookworm suite) is committed so the build
does not depend on a keyserver; the Containerfile checks its fingerprint.

## Corpus

`corpus.ts` holds three groups:

- **Reference programs** (`fixtures/*.ngc`) — hand-written from the QtPlasmaC
  manual, and they must pass: a single closed outline, a part with holes cut
  inside-first, several parts on one sheet, arc lead-ins, and inch output (on
  the inch machine, and again on the metric machine where the filter converts).
- **Negative programs** (`fixtures/negative/*.ngc`) — a reference program with
  one defect each: a cut outside any torch pair, no material select, the
  material wait missing, the material wait after the feed word, a syntax
  error, a material the material file lacks. They must be rejected, each for
  exactly its own rules. This is the mutation check: a negative program that
  passes, fails for some other reason, or trips only part of what it should,
  fails the run.
- **Exported programs** — empty until #959.

Every stanza in a reference program names the manual section it comes from
(<https://linuxcnc.org/docs/2.9/html/plasma/qtplasmac.html>). The sequence the
manual gives, and that the simulator confirmed:

```gcode
G21 G40 G49 G64 P0.1 G80 G90 G92.1 G94 G97   ; Preamble and Postamble Codes
M52 P1                                        ; Paused Motion
M190 P1                                       ; Automatic Material Handling:
M66 P3 L3 Q1                                  ;   select, wait for confirmation,
F#<_hal[plasmac.cut-feed-rate]>               ;   take the feed from the material
G0 X15 Y50
M3 $0 S1                                      ; Mandatory Codes: begin cut
G1 ...
M5 $0                                         ; Mandatory Codes: end cut
```

The manual says the three material codes "MUST be applied in the order shown".
Programs carry no Z moves: QtPlasmaC owns the torch height, and its filter
comments out Z motion in a loaded program.

### Adding exported programs (#959)

Add cases to `EXPORTED_CASES` in `corpus.ts`. Each one generates its program
from the current exporter, the way `../corpus.ts` does for the router corpus,
so the check always judges what we emit today:

```ts
{
  name: 'exported-single-outline',
  covers: 'through-cut profile on one closed outline, QtPlasmaC definition',
  machine: 'metric',
  program: () => runPostProcessor({ project, definition, operations, options }).gcode,
  expect: 'pass',
}
```

Nothing else changes — no new runner, no workflow edit. What the simulator
needs from a case:

- select material 1 or 2; material 0 is reserved (see the `material` rule);
- follow every `M190` with `M66 P3 L3 Qn` and then the feed word, and cut at
  the material's own feed (`material-wait`, `feed`);
- stay on the sim table: X/Y 0–1200 mm on the metric machine, 0–48 in on the
  imperial one;
- keep it small, because the run is real time.

## CI

`.github/workflows/qtplasmac-sim.yml` runs the check with Docker on pull
requests that touch this folder or the engine. It is a separate workflow from
`gcode-conformance.yml` because it shares nothing with it — no validator build,
no Debian `rs274` — and, like those jobs, it is not a required check.

Its first run on GitHub (ten programs, 2026-10-03) took **3 min 59 s** for the
whole job: 81 s to build the image, uncached, and 135 s to run the programs.

## Measured run time

On the maintainer's laptop (MacBookPro15,1, Podman machine with 6 CPUs and
2 GiB), with the image already built: **168 s** for the current twelve programs
(142 s for the eleven on the metric machine, 24 s for the one on the imperial
machine, 2026-10-04). The ten programs of the first version took 149 s, 152 s,
165 s and 177 s over four runs. A program runs 9-25 s; the rest is two LinuxCNC
start-ups and the per-program reset, filter and trace hand-over.

The first image build took **7 min 29 s** on the same machine, nearly all of it
downloading packages. Later builds reuse that layer and take seconds.

## What this does not prove

The simulator has no plasma arc. It proves QtPlasmaC accepts the program and
sequences the torch as intended; it says nothing about cut quality, kerf,
pierce delays that suit a real material, or torch height control. Those stay
with the real-table test tracked on #952.

## Files

- `run.ts` — host runner: builds the image, runs the container per machine, prints the verdicts.
- `corpus.ts` — the cases and what each must do.
- `verdict.ts`, `verdict.test.ts` — the rules, and their container-free test.
- `Containerfile` — the pinned simulator image.
- `sim/driver.py` — in-container driver: boots the sim, loads and runs each program, records the trace.
- `sim/filter_capture.py` — runs QtPlasmaC's load filter with its dialog captured.
- `sim/materials-*.cfg` — the sim's material files.
- `fixtures/` — reference and negative programs.

Output lands in `.gcode-conformance/qtplasmac/` (gitignored, wiped each run):
each program as sent, as QtPlasmaC's filter rewrote it, and the full simulator
report with the trace. Old images are not removed; clear them with
`podman images purecut-qtplasmac-sim` and `podman rmi`.
