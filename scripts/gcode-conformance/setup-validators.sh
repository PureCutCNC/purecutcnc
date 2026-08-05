#!/usr/bin/env bash
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
#
# Builds the controller interpreters used by `npm run check:gcode` (issue #450).
#
# Currently builds GRBL's own G-code parser for the desktop. grbl-sim wraps the
# unmodified grbl sources — including gcode.c, whose arc radius check the
# exporter reimplements — so a rejection here is the firmware's verdict, not a
# second opinion.
#
# LinuxCNC's rs274 is not built here: it ships in the linuxcnc-uspace package.
# Install it via your package manager and the runner will pick it up, or point
# RS274_BIN at the binary.

set -euo pipefail

OUT_DIR="${1:-$(pwd)/.gcode-conformance/validators}"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

# grbl v1.1 lives in gnea/grbl; the original grbl/grbl stalled at 0.9j.
# The arc radius check (0.005 mm / 0.5 mm / 0.1 % of radius) is byte-identical
# in both, so either would validate arcs — 1.1 is the current firmware.
GRBL_REPO="https://github.com/gnea/grbl.git"
GRBL_SIM_REPO="https://github.com/grbl/grbl-sim.git"

case "$(uname -s)" in
  Darwin) PLATFORM=OSX ;;
  Linux)  PLATFORM=LINUX ;;
  *)      echo "Unsupported platform: $(uname -s)" >&2; exit 1 ;;
esac

echo "Building grbl gvalidate for $PLATFORM"
git clone --depth 1 --quiet "$GRBL_REPO" "$WORK_DIR/grbl"
git clone --depth 1 --quiet "$GRBL_SIM_REPO" "$WORK_DIR/grbl/grbl/grbl-sim"

# grbl-sim defaults to LINUX; select the host platform.
sed -i.bak "s/^PLATFORM   = LINUX/PLATFORM   = $PLATFORM/" \
  "$WORK_DIR/grbl/grbl/grbl-sim/Makefile"

# grbl-sim declares globals (`wdt`, `io`) in headers without `extern`, relying
# on the pre-GCC-10 default of merging tentative definitions across translation
# units. GCC 10 flipped that default to -fno-common, so every object collides
# at link time. Apple clang still permits it, which is why this builds on macOS
# untouched and needs the flag on Linux. Harmless where it is already the
# behaviour, so it is passed unconditionally rather than branched on platform.
make -C "$WORK_DIR/grbl/grbl/grbl-sim" FLAGS="-g -O3 -fcommon" gvalidate >/dev/null

mkdir -p "$OUT_DIR"
cp "$WORK_DIR/grbl/grbl/grbl-sim/gvalidate.exe" "$OUT_DIR/"
echo "Installed $OUT_DIR/gvalidate.exe"

if command -v rs274 >/dev/null 2>&1; then
  echo "Found rs274 on PATH — LinuxCNC interpreter will also run."
else
  echo "rs274 not found; install linuxcnc-uspace to add the LinuxCNC interpreter."
fi
