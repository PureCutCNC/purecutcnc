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
"""Run QtPlasmaC's own load filter and capture what it would show the operator.

QtPlasmaC passes every program through `qtplasmac_gcode` when it is loaded
(the [FILTER] section of the ini). That filter is where QtPlasmaC's plasma
rules live: an M190 naming a material that is not in the material file, an M3
before any movement, a material change under cutter compensation. It reports
them in a dialog and waits for OK, which a headless run can never click.

This wrapper executes the unmodified filter with one substitution: the dialog's
`exec` reports the dialog's text instead of opening a window. The filtered
program still goes to stdout exactly as the GUI would receive it.

Runs INSIDE the simulator container (issue #954). Usage:
    filter_capture.py <program.ngc>      (INI_FILE_NAME must be set)
The report is one line on stderr: `@@FILTER@@ {"errors": "...", "warnings": "..."}`.
"""

import json
import runpy
import sys

from PyQt5.QtWidgets import QDialog, QLabel

FILTER = '/usr/bin/qtplasmac_gcode'
MARKER = '@@FILTER@@'


def report_instead_of_showing(dialog):
    # The filter builds one dialog: a heading label for each section (named
    # labelE1 / labelW1) followed by the label carrying that section's text.
    # A section with nothing to say has its heading hidden.
    sections = {'labelE1': 'errors', 'labelW1': 'warnings'}
    report = {'errors': '', 'warnings': ''}
    labels = dialog.findChildren(QLabel)
    for index, label in enumerate(labels[:-1]):
        section = sections.get(label.objectName())
        if section and not label.isHidden():
            report[section] = labels[index + 1].text().strip()
    sys.stderr.write(MARKER + ' ' + json.dumps(report) + '\n')
    sys.stderr.flush()
    return 0


QDialog.exec = report_instead_of_showing
QDialog.exec_ = report_instead_of_showing

sys.argv = [FILTER, sys.argv[1]]
runpy.run_path(FILTER, run_name='__main__')
