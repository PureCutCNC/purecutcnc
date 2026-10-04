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
   The one part of the sim config that is replaced is its float switch; see
   "Why the float switch is realtime".

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
| `trace` | the simulator, not the program: the sampler dropped samples, or `plasmac` stalled at a Z target, or the simulated sheet sits too close to a height where it can. Nothing is proven and the check fails |

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

## Why the float switch is realtime

QtPlasmaC finds the sheet by lowering the torch until its float switch trips.
In the sim config that switch is the sim panel, a GUI that polls the Z position
and presses the switch when the torch is below the sheet. How far the torch has
travelled by then depends on when the GUI polled, so every probe found a
different height. The driver replaces it with a HAL `comp` in the servo thread
(`attach_float_switch` in `sim/driver.py`), which trips at the same Z every
time. Every pierce of every run now holds the same Z count, and `run.ts` prints
it.

This is not tidiness. It is the fix for a stall that failed one of the check's
first five CI runs (#954), and its cause is in LinuxCNC 2.9.10 itself:

- `plasmac` waits at each Z target, with no timeout, until the applied Z offset
  equals the target, comparing the two after truncating them to 0.01 mm
  (`(int)(z_offset_current * offset_res) == (int)(cut_target * offset_scale * offset_res)`
  in `plasmac.comp`).
- Motion applies the offset through a planner that stops once it is within a
  small dead band of the command, not on it (`simple_tp.c`: "within 'tiny_dp'
  of desired pos, no need to move"). Measured here, it stopped 0.00000007 mm
  short.
- So when a target is *exactly* a multiple of 0.01 mm and the planner stops
  short of it, the applied offset truncates to one step less than the target,
  and `plasmac` sits in `CUT_HEIGHT` for ever with the torch on and motion
  held. A Z count is 0.00001 mm, so one height in a thousand is such a
  multiple, and with a random probe every pierce was a draw.

Reproduced on demand by shifting the probe result a few counts. With the
cut-height target at count -6,998,000 or -6,997,000 the run stalled in all five
attempts; at -6,998,001, one count away, and at -6,997,500 it ran normally.
The stall is the same picture as the CI failure: torch fired, the cut move
never started, timeout.

`SHEET_TOP` in the driver is chosen so the targets sit well clear of those
heights. Two guards keep that true, both reported as `trace` (the simulator,
not the program):

- a pierce within 50 counts of such a height fails the run and names
  `SHEET_TOP` as the constant to move;
- a run that times out with `plasmac` waiting at a Z target is reported as
  "the simulator stalled", with the state and the count, rather than as the
  program not completing.

The same code runs on a real table, so the stall may be possible there too.
That was not tested, and it has not been reported upstream.

## A second operator: the GUI

The QtPlasmaC GUI commands LinuxCNC too. On the first homing it runs `T0 M6`
through MDI, and whenever the interpreter goes idle it switches LinuxCNC back to
manual mode — each a little after the event, when it next polls. A Cycle Start
that lands just after such a switch is refused, and the refusal is silent here,
because LinuxCNC hands each error message to one reader and the GUI reads the
same channel. The program then simply never ran, which showed up as "stopped
before its last move" on a correct program.

The driver therefore waits for LinuxCNC to be idle and out of MDI after homing
(`let_gui_finish`), and confirms every Cycle Start: if the program has not
started within two seconds it lets the GUI finish and presses again
(`cycle_start`), logging that it did. Five refusals in a row are a simulator
failure and fail the check.

The only evidence of a start is LinuxCNC's own status: auto mode with the
interpreter busy, read after the press. The run trace is deliberately not
evidence. It arrives through a buffered pipe, so it can still be delivering
samples from before the press, and it changes for reasons that are not
execution — a material change moves the feed signal with nothing running.

`refused-cycle-start` in the corpus is the regression for this. It makes the
driver do what the GUI does at the wrong moment (manual mode just before the
first Cycle Start, plus a material change), and requires exactly two presses
and then a passing run.

The material pin is shared with the GUI in the same way. The load filter and
this driver ask for a material by writing `qtplasmac.material_change_number`;
the GUI acts on it when it next polls, and writes the same pin itself at the
end of the change. A request made while the GUI is still loading the previous
one is overwritten and lost. So the driver makes one request at a time: it
waits for the GUI to finish loading the material the filter selected
(`let_gui_load_selected_material`), then asks for the default and watches that
it is shown and stays shown, repeating the request if the pin is overwritten
(`select_default_material`).

One timing limit is QtPlasmaC's own and stays: its `M190` script gives the GUI
half a second to answer a material change. A simulator slower than that would
cut on the wrong material, and the `material` or `feed` rule would say so.

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

`corpus.ts` holds four groups:

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
- **Harness self-checks** — the harness checking itself in the real simulator:
  today one, `refused-cycle-start` (see "A second operator: the GUI").

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
2 GiB), with the image already built, five consecutive full runs of the twelve
programs took **163 s to 167 s** (2026-10-04): 138 s for the eleven on the
metric machine and 25 s for the one on the imperial machine. A program runs
8-23 s; the rest is two LinuxCNC start-ups and the per-program reset, filter
and trace hand-over. With the probe deterministic the run times repeat to
within a few seconds, and all five runs held the same pierce Z counts.

The harness self-check added a thirteenth program. Two runs with it took 191 s
and 202 s, on a machine that was busy with other work at the time.

On GitHub, the first run with the realtime float switch took 4 min 47 s for the
job, 115 s of it the image build, and printed the same pierce Z counts as the
laptop.

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
