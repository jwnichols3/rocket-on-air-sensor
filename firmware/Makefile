# The ESPHome lab for the on-air panel. Imported from jwnichols3/rocket-esp32 as
# files, not history (D-37) - that repo stays exactly as it is, as a lab.
#
# `config` is the target the root `npm run verify` calls: it validates the YAML with
# no hardware attached and no flash. Everything else here needs the board.
.PHONY: setup config validate compile dashboard flash logs clean

ESPHOME := .venv/bin/esphome
BUILDER := .venv/bin/esphome-device-builder
# EVERY board YAML, not just the first one. A gate that validates half the firmware
# while reporting success is worse than no gate (#57).
CONFIGS := configs/elegoo-esp32.yaml configs/crowpanel-7.yaml
# The default board for the single-board targets below (compile, flash, logs).
# Override on the command line: make compile CONFIG=configs/crowpanel-7.yaml
CONFIG ?= configs/elegoo-esp32.yaml

setup:
	uv sync

# Fails loudly rather than silently skipping: `npm run verify` claiming to have
# validated the firmware when it never ran esphome would be worse than no gate.
config:
	@test -x $(ESPHOME) || { \
	  echo "firmware: $(ESPHOME) not found - run 'make -C firmware setup' (needs uv)" >&2; exit 1; }
	@test -f configs/secrets.yaml || { \
	  echo "firmware: configs/secrets.yaml missing - copy configs/secrets.yaml.example and fill it in." >&2; \
	  echo "          It is gitignored; it holds the D-17 device credentials." >&2; exit 1; }
	@for c in $(CONFIGS); do echo "--- $$c"; $(ESPHOME) config $$c >/dev/null || exit 1; done
	@echo "firmware: all board configs valid"

# Kept as an alias: `validate` is what the lab repo called this.
validate: config

# The `Build` text_sensor (D-145) is the standing marker for "is the panel running what I just
# flashed". ESPHome 2026.8.0 regenerates its timestamp ONLY when the config hash or the
# ESPHome version changes (writer.py, copy_src_tree): a change to one of our `includes:`
# headers - onair_page.h, onair_table.h - moves neither, so the recompiled image carries the
# OLD timestamp and the marker cannot tell it from the running one. Measured 2026-09-04 (#96).
# Removing the cached build_info.json makes the writer regenerate it; that recompiles one
# generated .cpp and relinks, seconds not minutes.
compile:
	rm -f configs/.esphome/build/*/build_info.json
	$(ESPHOME) compile $(CONFIG)

dashboard:
	$(BUILDER) configs --host 127.0.0.1 --port 6052

# NEVER run this from an agent turn - `esphome run` tails logs with no timeout and
# hangs. Flash over the air with BOTH steps, in this order:
#
#   .venv/bin/esphome compile $(CONFIG)
#   .venv/bin/esphome upload --device <ip> $(CONFIG)
#
# `upload` ALONE DOES NOT COMPILE. It ships whatever binary is already in
# configs/.esphome/build/, so with a stale build it reports "OTA successful" while
# flashing the OLD firmware - and the panel comes back up, answers HTTP and looks entirely
# healthy. Cost the first time it happened: two flashes and a measurement of the previous
# build's behaviour, recorded as if it were the new one (#64). Check
# build/<name>/src/main.cpp for a value you just changed if a flash seems not to have
# taken.
flash:
	$(ESPHOME) run $(CONFIG)

logs:
	$(ESPHOME) logs $(CONFIG)

clean:
	$(ESPHOME) clean $(CONFIG)
