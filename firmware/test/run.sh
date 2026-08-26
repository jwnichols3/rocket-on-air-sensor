#!/usr/bin/env bash
# Host tests for the HTML the panel generates (#50). No device, no browser, no network.
#
# Compiles onair_table.h and onair_page.h against a small shim (shim/) that stands in for the
# handful of ESPHome symbols they touch, then asserts on the strings they produce.
set -euo pipefail
cd "$(dirname "$0")"

OUT="${TMPDIR:-/tmp}/onair-page-tests"
CXX="${CXX:-c++}"

# -fno-exceptions matches the device: ESP-IDF builds C++ with exceptions off, which is WHY a
# failed allocation there is abort() rather than a throw. Building the tests the same way
# keeps the byte-budget assertions honest about what they are protecting against.
"$CXX" -std=c++17 -fno-exceptions -fno-rtti -O1 -Wall -Wextra \
  -Wno-unused-parameter -Wno-missing-field-initializers \
  -I shim -I ../configs \
  test_page.cpp -o "$OUT"

"$OUT"
