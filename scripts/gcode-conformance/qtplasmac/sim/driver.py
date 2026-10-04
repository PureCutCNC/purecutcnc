#!/usr/bin/python3
#
# Copyright 2026 Franja (Frank) Povazanj
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""Drive LinuxCNC's QtPlasmaC simulator headless and record what it does.

Runs INSIDE the simulator container (issue #954); the host side is
`scripts/gcode-conformance/qtplasmac/run.ts`.

Input, one JSON document on stdin:
    {"machine": "metric" | "imperial",
     "timeoutSeconds": 120,
     "programs": [{"name": "...", "gcode": "...", "fault": "refused-start"}]}

`fault` is optional and only for the harness's own self-check: it makes the
driver sabotage that program's first Cycle Start (see `inject_refused_start`).

Output, one line on stdout: `@@RESULT@@ {...}`. Everything else (progress,
LinuxCNC's own log on failure) goes to stderr.

This file only *observes*. It decides nothing about whether a program is
acceptable — the verdict rules live in `verdict.ts` on the host, where they are
unit-tested without a container.

What each program goes through is what QtPlasmaC does to a file the operator
opens and runs:

1. `qtplasmac_gcode`, QtPlasmaC's load filter (see filter_capture.py).
2. The preview interpreter pass every LinuxCNC GUI makes on load. Interpreter
   errors surface here deterministically, with a line number.
3. A real run under milltask with the QtPlasmaC GUI, the `plasmac` HAL
   component and the simulated torch all live. M190 is executed by QtPlasmaC's
   own M190 script, and M3 $0 S1 really probes, pierces and waits for arc-OK.

During the run a realtime `sampler` records ten signals on every servo period
(1 kHz), so no move is too short to be seen:
    spindle.0.on        the program's own M3 / M5
    plasmac.torch-on    QtPlasmaC's torch output
    motion.motion-type  0 idle, 1 rapid, 2 feed, 3 arc
    motion.program-line the line being executed
    motion.current-vel  whether the machine is actually moving. A feed move is
                        "current" from the moment M3 is issued, but QtPlasmaC
                        holds it until the arc is established; without this
                        signal that wait would read as cutting with no torch.
    motion.feed-mm-per-minute (or -inches-) the feed of the move being
                        executed, in machine units whatever the program's
    plasmac.adaptive-feed  the factor QtPlasmaC is scaling that feed by (its
                        velocity reduction for small holes, for one). Dividing
                        it out leaves the F word the program set.
    plasmac.cut-feed-rate  the cut feed of the material QtPlasmaC has loaded.
                        It differs from the program's F when the feed was read
                        from the material before the material change took
                        effect, which the wait after M190 exists to prevent.
    plasmac.state-out, plasmac.z-offset-counts  where QtPlasmaC's own sequence
                        is, and the torch height it is holding. They are not
                        judged; they say what the simulator was doing if a run
                        stalls, and they show the probe landing on the same
                        height every time (see `attach_float_switch`).
"""

import glob
import json
import os
import subprocess
import sys
import threading
import time
import traceback

SIM_DIR = '/home/cnc/sim'
WORK_DIR = '/tmp/qtplasmac-check'
FILTER_CAPTURE = '/opt/qtplasmac-check/filter_capture.py'
INI_FILES = {
    'metric': 'qtplasmac_l_metric.ini',
    'imperial': 'qtplasmac_l_imperial.ini',
}
# The material QtPlasmaC falls back to ("Default material" in its prefs file,
# defined as number 0 in sim/materials-*.cfg). The check resets to it before
# every run, so a torch that fires on it means the program never selected one.
DEFAULT_MATERIAL = 0
RESULT_MARKER = '@@RESULT@@'
BOOT_TIMEOUT = 180
# An accidental realtime hiccup is reported by LinuxCNC on the same channel as
# program errors. It says nothing about the program.
IGNORED_ERRORS = ('Unexpected realtime delay',)
# Where the top of the simulated sheet is, in machine units above Z zero. See
# `attach_float_switch` for why the exact value matters.
SHEET_TOP = {'metric': 22.0105, 'imperial': 0.85}
# `plasmac.state-out`, from the state enum in LinuxCNC's plasmac.comp.
PLASMAC_STATES = (
    'IDLE', 'PROBE_HEIGHT', 'PROBE_DOWN', 'PROBE_UP', 'ZERO_HEIGHT', 'PIERCE_HEIGHT', 'TORCH_ON', 'ARC_OK',
    'PIERCE_DELAY', 'PUDDLE_JUMP', 'CUT_HEIGHT', 'CUT_MODE_01', 'CUT_MODE_2', 'PAUSE_AT_END', 'SAFE_HEIGHT',
    'MAX_HEIGHT', 'END_CUT', 'END_JOB', 'TORCHPULSE', 'PAUSED_MOTION', 'OHMIC_TEST', 'PROBE_TEST', 'SCRIBING',
    'CONSUMABLE_CHANGE_ON', 'CONSUMABLE_CHANGE_OFF', 'CUT_RECOVERY_ON', 'CUT_RECOVERY_OFF', 'DEBUG',
)


def log(message):
    sys.stderr.write('[sim] ' + message + '\n')
    sys.stderr.flush()


class HarnessError(Exception):
    """The simulator itself misbehaved; no verdict about any program."""


def halcmd(*args):
    done = subprocess.run(['halcmd', *args], capture_output=True, text=True)
    return done.returncode, done.stdout.strip(), done.stderr.strip()


def wait_for(predicate, timeout, what, interval=0.05):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return
        time.sleep(interval)
    raise HarnessError('timed out waiting for ' + what)


class Trace(threading.Thread):
    """Reads `halsampler` and keeps the samples where something changed."""

    def __init__(self, hal):
        super().__init__(daemon=True)
        self.hal = hal
        self.process = subprocess.Popen(
            ['halsampler', '-c', '0', '-t'], stdout=subprocess.PIPE, text=True, bufsize=1)
        self.lock = threading.Lock()
        self.capturing = False
        self.events = []
        self.first_torch_on = None
        self.last = None
        self.last_index = None
        self.samples = 0
        self.gaps = 0
        self.programmed_feed = 0.0
        self.pierce_z_counts = []
        self.plasmac_state = 0
        self.z_counts = 0

    def run(self):
        for raw in self.process.stdout:
            parts = raw.split()
            if len(parts) != 11:
                continue
            index = int(parts[0])
            self.plasmac_state, self.z_counts = int(parts[9]), int(parts[10])
            moving = 1 if float(parts[5]) > 0 else 0
            # motion reports F x feed override x adaptive feed. The override
            # stays at 100 % here; dividing by the adaptive factor recovers F.
            # While QtPlasmaC holds or reverses motion the factor is not a
            # scale, so the last known F stands.
            scaled_feed, adaptive = float(parts[6]), float(parts[8])
            if scaled_feed == 0:
                self.programmed_feed = 0.0
            elif adaptive > 0:
                self.programmed_feed = round(scaled_feed / adaptive, 3)
            state = (int(parts[1]), int(parts[2]), int(parts[3]), int(parts[4]), moving,
                     self.programmed_feed, round(float(parts[7]), 3))
            with self.lock:
                if self.last_index is not None and index != self.last_index + 1:
                    self.gaps += 1
                self.last_index = index
                previous = self.last
                self.last = state
                if not self.capturing:
                    continue
                self.samples += 1
                if state == previous and self.events:
                    continue
                self.events.append([index, *state])
                if state[1] == 1 and (previous is None or previous[1] == 0):
                    # The torch fires at pierce height: the Z count QtPlasmaC
                    # derived from this pierce's probe.
                    self.pierce_z_counts.append(self.z_counts)
                rising = state[0] == 1 and (previous is None or previous[0] == 0)
                if rising and self.first_torch_on is None:
                    # Read at the moment the program's first M3 takes effect:
                    # which material QtPlasmaC has loaded, and its cut feed.
                    self.first_torch_on = {
                        'material': int(self.hal.get_value('qtplasmac.material_change_number')),
                        'cutFeedRate': float(self.hal.get_value('plasmac.cut-feed-rate')),
                    }

    def wait_until_caught_up(self):
        """Block until every sample taken so far has been read.

        `halsampler` writes through a block-buffered pipe, so what this thread
        has seen trails the machine by a few hundred samples. Waiting for one
        more second of samples than had arrived when the run ended puts the
        whole run, and its last torch-off, safely inside the trace.
        """
        with self.lock:
            mark = self.last_index or 0

        def caught_up():
            with self.lock:
                return (self.last_index or 0) >= mark + 1000
        wait_for(caught_up, 10, 'the trace to catch up with the run')

    def start_capture(self):
        with self.lock:
            self.events = []
            self.first_torch_on = None
            self.samples = 0
            self.gaps = 0
            self.pierce_z_counts = []
            self.capturing = True

    def stop_capture(self):
        with self.lock:
            self.capturing = False
            return {
                'events': self.events,
                'samples': self.samples,
                'gaps': self.gaps,
                'firstTorchOn': self.first_torch_on,
                'pierceZCounts': self.pierce_z_counts,
            }

    def plasmac_now(self):
        with self.lock:
            return self.plasmac_state, self.z_counts


class PreviewCanon:
    """The minimum the preview interpreter needs from a canon object.

    Records only which line produced the last motion, so the run can be
    checked against it: a run that stops early never executes that line.
    """

    def __init__(self, parameter_file):
        self.parameter_file = parameter_file
        self.line = 0
        self.last_motion_line = 0
        self.motion_lines = 0

    def next_line(self, state):
        self.line = state.sequence_number

    def check_abort(self):
        return False

    def get_external_angular_units(self):
        return 1.0

    def get_external_length_units(self):
        return 1.0

    def get_axis_mask(self):
        return 7

    def get_block_delete(self):
        return 0

    def get_tool(self, pocket):
        return -1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0

    def __getattr__(self, name):
        if name.startswith('_'):
            raise AttributeError(name)

        def canon_call(*args):
            if name in ('straight_feed', 'arc_feed', 'straight_traverse'):
                self.last_motion_line = self.line
                self.motion_lines += 1

        return canon_call


class Simulator:
    def __init__(self, machine):
        self.machine = machine
        self.ini_name = INI_FILES[machine]
        self.ini_path = os.path.join(SIM_DIR, self.ini_name + '.expanded')
        self.linuxcnc_log = os.path.join(WORK_DIR, 'linuxcnc.log')
        self.processes = []

    # ── boot ────────────────────────────────────────────────────────────

    def boot(self):
        os.makedirs(WORK_DIR, exist_ok=True)
        os.environ['DISPLAY'] = ':99'
        self.processes.append(subprocess.Popen(
            ['Xvfb', ':99', '-screen', '0', '1920x1080x24', '-nolisten', 'tcp'],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
        wait_for(lambda: os.path.exists('/tmp/.X11-unix/X99'), 20, 'the virtual display')

        log('starting LinuxCNC with ' + self.ini_name)
        with open(self.linuxcnc_log, 'w') as out:
            self.processes.append(subprocess.Popen(
                ['linuxcnc', self.ini_name], cwd=SIM_DIR, stdout=out, stderr=subprocess.STDOUT))

        # The sim panel is the last thing the config loads (postgui), so its
        # pins existing means the QtPlasmaC GUI is up too.
        def gui_ready():
            if 'Shutting down and cleaning up LinuxCNC' in self.log_tail():
                raise HarnessError('LinuxCNC failed to start')
            return (halcmd('getp', 'qtplasmac_sim.material_height')[0] == 0
                    and halcmd('getp', 'qtplasmac.material_change_number')[0] == 0)
        wait_for(gui_ready, BOOT_TIMEOUT, 'the QtPlasmaC GUI and its sim panel', interval=0.5)

        # LinuxCNC exports this to every GUI it starts. The interpreter reads
        # it to find the ini, without which #<_hal[...]> and #<_ini[...]> are
        # undefined.
        os.environ['INI_FILE_NAME'] = self.ini_path
        # Imported only now: both modules attach to the running LinuxCNC.
        import hal
        import linuxcnc
        self.hal = hal
        self.linuxcnc = linuxcnc
        self.component = hal.component('simcheck')
        self.component.ready()
        self.stat = linuxcnc.stat()
        self.command = linuxcnc.command()
        self.error_channel = linuxcnc.error_channel()
        self.ini = linuxcnc.ini(self.ini_path)

        self.attach_sampler()
        self.attach_float_switch()
        self.power_up()
        self.default_cut_feed = float(hal.get_value('plasmac.cut-feed-rate'))
        # plasmac truncates Z to 0.01 mm on a metric machine and 0.001 in on an
        # imperial one (`offset_res` in plasmac.comp); this is that step in
        # counts, the spacing of the heights it can stall on.
        truncation = 100 if self.machine == 'metric' else 1000
        self.z_boundary_counts = round(1 / (float(hal.get_value('plasmac.offset-scale')) * truncation))
        log('ready: LinuxCNC %s, default cut feed %s' % (self.version(), self.default_cut_feed))

    def version(self):
        done = subprocess.run(
            ['dpkg-query', '-W', '-f', '${Version}', 'linuxcnc-uspace'], capture_output=True, text=True)
        return done.stdout.strip()

    def attach_sampler(self):
        # Most of these signals already exist in QtPlasmaC's own HAL
        # (qtplasmac_comp.hal and the GUI's own nets); the sampler only listens.
        # motion.feed-upm is in the *program's* units, so a G20 program on a
        # metric machine would not compare with the material's feed; the
        # per-unit pins are in fixed units.
        feed_pin = 'motion.feed-mm-per-minute' if self.machine == 'metric' else 'motion.feed-inches-per-minute'
        setup = [
            ['loadrt', 'sampler', 'depth=16384', 'cfg=bbssffffss'],
            ['net', 'plasmac:cutting-start', 'sampler.0.pin.0'],
            ['net', 'plasmac:torch-on', 'sampler.0.pin.1'],
            ['net', 'plasmac:motion-type', 'sampler.0.pin.2'],
            ['net', 'simcheck:program-line', 'motion.program-line', 'sampler.0.pin.3'],
            ['net', 'plasmac:current-velocity', 'sampler.0.pin.4'],
            ['net', 'simcheck:feed', feed_pin, 'sampler.0.pin.5'],
            ['net', 'plasmac:cut-feed-rate', 'sampler.0.pin.6'],
            ['net', 'plasmac:adaptive-feed', 'sampler.0.pin.7'],
            ['net', 'plasmac:state', 'sampler.0.pin.8'],
            ['net', 'plasmac:z-offset-counts', 'sampler.0.pin.9'],
            ['addf', 'sampler.0', 'servo-thread'],
        ]
        for step in setup:
            code, _, err = halcmd(*step)
            if code != 0:
                raise HarnessError('halcmd %s failed: %s' % (' '.join(step), err))
        self.trace = Trace(self.hal)
        self.trace.start()

    def attach_float_switch(self):
        """Give the simulated torch a float switch that trips in realtime.

        QtPlasmaC finds the sheet by lowering the torch until its float switch
        trips. The sim config's switch is the sim panel: a GUI, not realtime,
        that polls the Z position and presses the switch when the torch is
        below the sheet. How far the torch has travelled by then depends on
        when the GUI happened to poll, so every probe found a slightly
        different height, and with it a different Z target for the pierce and
        the cut.

        That randomness is what made this check flaky (issue #954). LinuxCNC
        2.9.10's plasmac waits at each Z target, with no timeout, until the
        applied Z offset equals the target, comparing the two after truncating
        them to 0.01 mm (0.001 in). But motion applies an offset through a
        planner that stops once it is within a small dead band of the command
        (simple_tp.c: "within 'tiny_dp' of desired pos, no need to move"), not
        on it; here it was measured stopping 0.00000007 mm short. When a
        target is *exactly* a multiple of 0.01 mm and the planner stops short
        of it, the applied offset truncates to one step less than the target,
        and plasmac waits in CUT_HEIGHT for ever: torch on, motion held. A Z
        count is 0.00001 mm, so one height in a thousand is such a multiple.

        A `comp` in the servo thread trips at the same Z on every probe, so
        every pierce in every run gets the same targets. SHEET_TOP is chosen
        so those targets sit well away from a boundary; the Z count of each
        pierce is reported so that stays visible.
        """
        setup = [
            ['loadrt', 'comp', 'count=1'],
            ['addf', 'comp.0', 'servo-thread'],
            # comp.0.out is true while in1 > in0: sheet top above the torch.
            ['setp', 'comp.0.in1', repr(SHEET_TOP[self.machine])],
            ['net', 'plasmac:axis-position', 'comp.0.in0'],
            # Take the sim panel's own switch off the signal and drive it here.
            ['unlinkp', 'qtplasmac_sim.sensor_float'],
            ['net', 'sim:float', 'comp.0.out'],
        ]
        for step in setup:
            code, _, err = halcmd(*step)
            if code != 0:
                raise HarnessError('halcmd %s failed: %s' % (' '.join(step), err))

    def power_up(self):
        hal, linuxcnc, command = self.hal, self.linuxcnc, self.command
        # The sim panel starts with its E-stop button pressed.
        hal.set_p('estop_or.in0', '0')
        time.sleep(0.2)
        command.state(linuxcnc.STATE_ESTOP_RESET)
        command.wait_complete()
        command.state(linuxcnc.STATE_ON)
        command.wait_complete()
        wait_for(self.machine_on, 10, 'the machine to turn on')
        self.home()

        # QtPlasmaC starts with the torch disabled (a dry run). The check is
        # about the torch output, so press TORCH ENABLE through the pin the
        # manual documents for an external button.
        for _ in range(5):
            if hal.get_value('qtplasmac.torch_enable'):
                break
            hal.set_p('qtplasmac.ext_torch_enable', '1')
            time.sleep(0.4)
            hal.set_p('qtplasmac.ext_torch_enable', '0')
            time.sleep(0.4)
        if not hal.get_value('qtplasmac.torch_enable'):
            raise HarnessError('could not enable the torch in the QtPlasmaC GUI')

    def machine_on(self):
        self.stat.poll()
        return self.stat.task_state == self.linuxcnc.STATE_ON

    def home(self):
        linuxcnc, command = self.linuxcnc, self.command
        command.mode(linuxcnc.MODE_MANUAL)
        command.wait_complete()
        command.teleop_enable(0)
        command.wait_complete()
        command.home(-1)

        def homed():
            self.stat.poll()
            return all(self.stat.homed[:self.stat.joints])
        wait_for(homed, 60, 'homing')
        self.let_gui_finish()

    def let_gui_finish(self):
        """Wait until nobody is running anything through LinuxCNC.

        The QtPlasmaC GUI is a second operator on the same LinuxCNC. On the
        first homing it runs `T0 M6` through MDI and then returns to manual
        mode; whenever the interpreter goes idle it returns to manual mode
        again. It does these when it next polls, a little after the event, so
        a command sent meanwhile can land in the wrong mode.

        Quiet means: interpreter idle and not in MDI mode, held for a moment.
        """
        linuxcnc = self.linuxcnc
        quiet_since = None
        deadline = time.time() + 15
        while time.time() < deadline:
            self.stat.poll()
            quiet = (self.stat.interp_state == linuxcnc.INTERP_IDLE
                     and self.stat.task_mode != linuxcnc.MODE_MDI)
            if not quiet:
                quiet_since = None
            elif quiet_since is None:
                quiet_since = time.time()
            elif time.time() - quiet_since >= 0.5:
                return
            time.sleep(0.02)
        raise HarnessError('LinuxCNC never became idle; the QtPlasmaC GUI is still running something')

    def executing(self):
        """Whether LinuxCNC is executing a program right now.

        Read from LinuxCNC's status, which is current, and required to be in
        auto mode: the GUI running something through MDI also makes the
        interpreter busy, and that is not this program.
        """
        linuxcnc = self.linuxcnc
        self.stat.poll()
        return (self.stat.task_mode == linuxcnc.MODE_AUTO
                and self.stat.interp_state != linuxcnc.INTERP_IDLE)

    def cycle_start(self, has_motion, fault=None):
        """Run the opened program, and make sure it really started.

        A Cycle Start that arrives just after the GUI has switched LinuxCNC to
        manual mode is refused, and the refusal is silent here: LinuxCNC
        reports it on an error channel the GUI reads too, and whichever reads
        first gets the message. Without this check the program simply never
        ran, which reads as "stopped before its last move".

        So confirm the start, and if it did not take, let the GUI finish and
        press again, as an operator would. After a few attempts it is a
        simulator fault, never a quiet pass. Returns the number of presses.

        The only evidence accepted is LinuxCNC itself executing in auto mode
        after this press. The run trace is no evidence: it is read through a
        buffered pipe, so it can still be delivering samples from before the
        press, and things change in it that are not execution (a material
        change moves the feed signal with nothing running).
        """
        linuxcnc, command = self.linuxcnc, self.command
        for attempt in range(1, 6):
            command.mode(linuxcnc.MODE_AUTO)
            command.wait_complete()
            if fault == 'refused-start' and attempt == 1:
                self.inject_refused_start()
            command.auto(linuxcnc.AUTO_RUN, 0)
            if not has_motion:
                # Nothing to watch for: a program with no moves ends at once.
                return attempt
            deadline = time.time() + 2
            while time.time() < deadline:
                if self.executing():
                    return attempt
                time.sleep(0.01)
            self.stat.poll()
            log('cycle start %d did not take (task mode %d); pressing again' % (attempt, self.stat.task_mode))
            self.let_gui_finish()
        raise HarnessError('the program could not be started in the simulator')

    def inject_refused_start(self):
        """Self-check only: reproduce the GUI getting in ahead of Cycle Start.

        Puts LinuxCNC back in manual mode, as the GUI does, so the Cycle Start
        that follows is refused. Also changes the material, which moves the
        feed signal in the trace with nothing executing: exactly what an
        earlier version of the confirmation mistook for a program starting.
        """
        linuxcnc, command = self.linuxcnc, self.command
        command.mode(linuxcnc.MODE_MANUAL)
        command.wait_complete()
        self.hal.set_p('qtplasmac.material_change_number', '2')

    # ── one program ─────────────────────────────────────────────────────

    def drain_errors(self):
        messages = []
        while True:
            message = self.error_channel.poll()
            if not message:
                break
            text = str(message[1]).strip()
            if not any(ignored in text for ignored in IGNORED_ERRORS):
                messages.append(text)
        return messages

    def idle(self):
        self.stat.poll()
        return self.stat.interp_state == self.linuxcnc.INTERP_IDLE

    def torch_quiet(self):
        hal = self.hal
        return (not hal.get_value('spindle.0.on')
                and not hal.get_value('plasmac.torch-on')
                and int(hal.get_value('plasmac.state-out')) == 0)

    def reset(self):
        """Return to a known state so one program cannot affect the next."""
        linuxcnc, command, hal = self.linuxcnc, self.command, self.hal
        command.abort()
        command.wait_complete()
        wait_for(self.idle, 20, 'the interpreter to go idle')
        if not self.machine_on():
            hal.set_p('estop_or.in0', '0')
            command.state(linuxcnc.STATE_ESTOP_RESET)
            command.wait_complete()
            command.state(linuxcnc.STATE_ON)
            command.wait_complete()
            wait_for(self.machine_on, 10, 'the machine to turn back on')
        self.stat.poll()
        if not all(self.stat.homed[:self.stat.joints]):
            self.home()
        wait_for(self.torch_quiet, 30, 'the torch and the plasmac component to settle')
        self.select_default_material()
        self.drain_errors()

    def select_default_material(self):
        hal = self.hal
        hal.set_p('qtplasmac.material_change_number', str(DEFAULT_MATERIAL))

        def default_loaded():
            return (int(hal.get_value('qtplasmac.material_change_number')) == DEFAULT_MATERIAL
                    and float(hal.get_value('plasmac.cut-feed-rate')) == self.default_cut_feed)
        wait_for(default_loaded, 10, 'QtPlasmaC to load its default material')

    def run_filter(self, source_path):
        try:
            done = subprocess.run(
                ['python3', FILTER_CAPTURE, source_path], cwd=SIM_DIR,
                capture_output=True, text=True, timeout=120)
        except subprocess.TimeoutExpired:
            raise HarnessError('the QtPlasmaC load filter did not finish')
        dialog = {'errors': '', 'warnings': ''}
        for line in done.stderr.splitlines():
            if line.startswith('@@FILTER@@ '):
                dialog = json.loads(line[len('@@FILTER@@ '):])
        if done.returncode != 0:
            raise HarnessError('the QtPlasmaC load filter crashed: ' + done.stderr[-2000:])
        return done.stdout, dialog

    def preview(self, filtered_path):
        import gcode
        canon = PreviewCanon(self.ini.find('RS274NGC', 'PARAMETER_FILE'))
        unit_code = 'G21' if self.machine == 'metric' else 'G20'
        startup = self.ini.find('RS274NGC', 'RS274NGC_STARTUP_CODE') or ''
        result, sequence = gcode.parse(filtered_path, canon, unit_code, startup)
        error = None
        if result > gcode.MIN_ERROR:
            error = {'line': sequence, 'message': gcode.strerror(result)}
        return {
            'error': error,
            'lastMotionLine': canon.last_motion_line,
            'motionLines': canon.motion_lines,
        }

    def execute(self, filtered_path, timeout, has_motion, fault=None):
        linuxcnc, command = self.linuxcnc, self.command
        command.mode(linuxcnc.MODE_AUTO)
        command.wait_complete()
        command.program_open(filtered_path)
        command.wait_complete()
        errors = self.drain_errors()

        self.trace.start_capture()
        started = time.time()
        start_attempts = self.cycle_start(has_motion, fault)
        left_idle = has_motion
        timed_out = False
        stall = None
        while True:
            errors += self.drain_errors()
            idle = self.idle()
            left_idle = left_idle or not idle
            elapsed = time.time() - started
            # A program can finish before the first poll sees it running.
            if idle and (left_idle or elapsed > 2):
                break
            if elapsed > timeout:
                timed_out = True
                stall = self.describe_stall()
                break
            time.sleep(0.02)
        run_seconds = round(time.time() - started, 2)
        self.trace.wait_until_caught_up()
        errors += self.drain_errors()
        self.stat.poll()
        finished = {
            'spindleOn': bool(self.hal.get_value('spindle.0.on')),
            'torchOn': bool(self.hal.get_value('plasmac.torch-on')),
            'machineOn': self.stat.task_state == linuxcnc.STATE_ON,
        }
        trace = self.trace.stop_capture()
        overruns = int(self.hal.get_value('sampler.0.overruns'))
        return {
            'timedOut': timed_out,
            'startAttempts': start_attempts,
            'stall': stall,
            'pierceZCounts': trace['pierceZCounts'],
            'zBoundaryCounts': self.z_boundary_counts,
            'errors': errors,
            'seconds': run_seconds,
            'atEnd': finished,
            'traceComplete': trace['gaps'] == 0 and overruns == 0,
            'samples': trace['samples'],
            'firstTorchOn': trace['firstTorchOn'],
            'events': trace['events'],
        }

    def describe_stall(self):
        """What QtPlasmaC's own sequence was doing when a run ran out of time."""
        hal = self.hal
        state, z_counts = self.trace.plasmac_now()
        return {
            'plasmacState': PLASMAC_STATES[state] if 0 <= state < len(PLASMAC_STATES) else str(state),
            'zCounts': z_counts,
            'zOffset': float(hal.get_value('axis.z.eoffset')),
            'offsetScale': float(hal.get_value('plasmac.offset-scale')),
            'feedHold': bool(hal.get_value('plasmac.feed-hold')),
            'torchOn': bool(hal.get_value('plasmac.torch-on')),
            'arcOk': bool(hal.get_value('plasmac.arc-ok-out')),
        }

    def check(self, program, timeout):
        name = program['name']
        log('program ' + name)
        self.reset()
        source_path = os.path.join(WORK_DIR, name + '.ngc')
        with open(source_path, 'w') as out:
            out.write(program['gcode'])

        filtered, dialog = self.run_filter(source_path)
        filtered_path = os.path.join(WORK_DIR, name + '.filtered.ngc')
        with open(filtered_path, 'w') as out:
            out.write(filtered)
        # The filter pre-selects the program's first material while loading.
        # Undo that, so the run itself has to select it before the torch fires.
        self.select_default_material()

        report = {
            'name': name,
            'filterErrors': dialog['errors'],
            'filterWarnings': dialog['warnings'],
            'filtered': filtered.splitlines(),
            'preview': None,
            'run': None,
        }
        # QtPlasmaC refuses a file its filter found errors in ("Errors must be
        # fixed before reloading this file"), so there is nothing to run.
        if dialog['errors']:
            return report

        report['preview'] = self.preview(filtered_path)
        # Running a file the interpreter already rejected proves nothing more,
        # and an interpreter error mid-run leaves the torch on until an abort.
        if report['preview']['error'] is None:
            report['run'] = self.execute(
                filtered_path, timeout, report['preview']['motionLines'] > 0, program.get('fault'))
        return report

    def shutdown(self):
        for process in reversed(self.processes):
            process.terminate()

    def log_tail(self):
        """LinuxCNC's own account of a failed start.

        The launcher script keeps its output in /tmp/linuxcnc.print.* and
        /tmp/linuxcnc.debug.* and shows them in a dialog, so stdout alone is
        usually empty exactly when something went wrong.
        """
        text = ''
        for path in [self.linuxcnc_log, *sorted(glob.glob('/tmp/linuxcnc.print.*')),
                     *sorted(glob.glob('/tmp/linuxcnc.debug.*'))]:
            try:
                with open(path) as source:
                    text += source.read()[-3000:]
            except OSError:
                pass
        return text


def main():
    request = json.load(sys.stdin)
    simulator = Simulator(request['machine'])
    result = {'machine': request['machine'], 'linuxcncVersion': None, 'programs': [], 'harnessError': None}
    try:
        simulator.boot()
        result['linuxcncVersion'] = simulator.version()
        for program in request['programs']:
            result['programs'].append(simulator.check(program, request.get('timeoutSeconds', 120)))
    except Exception as error:  # noqa: BLE001 - every failure must reach the host as a harness error
        result['harnessError'] = '%s: %s' % (type(error).__name__, error)
        log('HARNESS ERROR: ' + result['harnessError'])
        log(traceback.format_exc())
        log(simulator.log_tail())
    finally:
        simulator.shutdown()
    sys.stdout.write(RESULT_MARKER + ' ' + json.dumps(result) + '\n')
    sys.stdout.flush()
    # LinuxCNC's own shutdown is slow and its outcome is irrelevant here; the
    # container is discarded.
    os._exit(0)


if __name__ == '__main__':
    main()
