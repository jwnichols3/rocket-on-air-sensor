# The ESPHome lab for the on-air panel. Imported from jwnichols3/rocket-esp32 as
# files, not history (D-37) - that repo stays exactly as it is, as a lab.
#
# `config` is the target the root `npm run verify` calls: it validates the YAML with
# no hardware attached and no flash. Everything else here needs the board.
.PHONY: setup config validate compile dashboard flash logs clean

ESPHOME := .venv/bin/esphome
BUILDER := .venv/bin/esphome-device-builder
CONFIG := configs/elegoo-esp32.yaml

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
	$(ESPHOME) config $(CONFIG)

# Kept as an alias: `validate` is what the lab repo called this.
validate: config

compile:
	$(ESPHOME) compile $(CONFIG)

dashboard:
	$(BUILDER) configs --host 127.0.0.1 --port 6052

# NEVER run this from an agent turn - `esphome run` tails logs with no timeout and
# hangs. Flash over the air with: .venv/bin/esphome upload --device <ip> $(CONFIG)
flash:
	$(ESPHOME) run $(CONFIG)

logs:
	$(ESPHOME) logs $(CONFIG)

clean:
	$(ESPHOME) clean $(CONFIG)
