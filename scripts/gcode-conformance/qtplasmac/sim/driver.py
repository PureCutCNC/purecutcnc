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
     "programs": [{"name": "...", "gcode": "..."}]}

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

During the run a realtime `sampler` records five signals on every servo period
(1 kHz), so no move is too short to be seen:
    spindle.0.on        the program's own M3 / M5
    plasmac.torch-on    QtPlasmaC's torch output
    motion.motion-type  0 idle, 1 rapid, 2 feed, 3 arc
    motion.program-line the line being executed
    motion.current-vel  whether the machine is actually moving. A feed move is
                        "current" from the moment M3 is issued, but QtPlasmaC
                        holds it until the arc is established; without this
                        signal that wait would read as cutting with no torch.
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

    def run(self):
        for raw in self.process.stdout:
            parts = raw.split()
            if len(parts) != 6:
                continue
            index = int(parts[0])
            moving = 1 if float(parts[5]) > 0 else 0
            state = (int(parts[1]), int(parts[2]), int(parts[3]), int(parts[4]), moving)
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
            self.capturing = True

    def stop_capture(self):
        with self.lock:
            self.capturing = False
            return {
                'events': self.events,
                'samples': self.samples,
                'gaps': self.gaps,
                'firstTorchOn': self.first_torch_on,
            }


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
        self.power_up()
        self.default_cut_feed = float(hal.get_value('plasmac.cut-feed-rate'))
        log('ready: LinuxCNC %s, default cut feed %s' % (self.version(), self.default_cut_feed))

    def version(self):
        done = subprocess.run(
            ['dpkg-query', '-W', '-f', '${Version}', 'linuxcnc-uspace'], capture_output=True, text=True)
        return done.stdout.strip()

    def attach_sampler(self):
        # Four of the five signals already exist in QtPlasmaC's own HAL file
        # (qtplasmac_comp.hal); the sampler only listens to them.
        setup = [
            ['loadrt', 'sampler', 'depth=16384', 'cfg=bbssf'],
            ['net', 'plasmac:cutting-start', 'sampler.0.pin.0'],
            ['net', 'plasmac:torch-on', 'sampler.0.pin.1'],
            ['net', 'plasmac:motion-type', 'sampler.0.pin.2'],
            ['net', 'simcheck:program-line', 'motion.program-line', 'sampler.0.pin.3'],
            ['net', 'plasmac:current-velocity', 'sampler.0.pin.4'],
            ['addf', 'sampler.0', 'servo-thread'],
        ]
        for step in setup:
            code, _, err = halcmd(*step)
            if code != 0:
                raise HarnessError('halcmd %s failed: %s' % (' '.join(step), err))
        self.trace = Trace(self.hal)
        self.trace.start()

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

        # Thicken the simulated sheet so its top sits just under QtPlasmaC's
        # probe start height (25 mm / 1 in above Z's lower limit). Probing
        # runs at probe speed only below that height, so this shortens every
        # pierce by a few seconds without changing what is exercised.
        hal.set_p('qtplasmac_sim.material_height', '17' if self.machine == 'metric' else '0.65')

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

    def execute(self, filtered_path, timeout):
        linuxcnc, command = self.linuxcnc, self.command
        command.mode(linuxcnc.MODE_AUTO)
        command.wait_complete()
        command.program_open(filtered_path)
        command.wait_complete()
        errors = self.drain_errors()

        self.trace.start_capture()
        started = time.time()
        command.auto(linuxcnc.AUTO_RUN, 0)
        left_idle = False
        timed_out = False
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
            'errors': errors,
            'seconds': run_seconds,
            'atEnd': finished,
            'traceComplete': trace['gaps'] == 0 and overruns == 0,
            'samples': trace['samples'],
            'firstTorchOn': trace['firstTorchOn'],
            'events': trace['events'],
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
            report['run'] = self.execute(filtered_path, timeout)
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
