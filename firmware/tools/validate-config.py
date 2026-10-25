#!/usr/bin/env python3
"""Keep ESPHome's failure context without printing the resolved credential document."""

import argparse
import json
from pathlib import Path
import re
import subprocess
import sys

import yaml


def secret_values(path: Path) -> list[str]:
    """Fail closed if secrets cannot be read; a YAML exception can itself quote a secret."""
    document = yaml.safe_load(path.read_text())
    if not isinstance(document, dict):
        raise ValueError("expected a secrets mapping")

    def strings(value):
        if isinstance(value, dict):
            for item in value.values():
                yield from strings(item)
        elif isinstance(value, list):
            for item in value:
                yield from strings(item)
        elif isinstance(value, str) and value:
            yield value
        elif isinstance(value, (int, float, bool)):
            yield str(value)
            yield str(value).lower()

    return list(strings(document))


def redact(text: str, secrets: list[str]) -> str:
    # Strip terminal control sequences before matching values, including error highlighting.
    text = re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", text)
    values = set(secrets)
    for value in secrets:
        values.add(json.dumps(value, ensure_ascii=False)[1:-1])
        values.add(json.dumps(value, ensure_ascii=True)[1:-1])
    for value in sorted(values, key=len, reverse=True):
        text = text.replace(value, "<REDACTED>")
    return text


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--esphome", default=".venv/bin/esphome")
    parser.add_argument("--secrets", type=Path, default=Path("configs/secrets.yaml"))
    parser.add_argument("configs", nargs="+")
    args = parser.parse_args()
    try:
        secrets = secret_values(args.secrets)
    except (OSError, ValueError, yaml.YAMLError):
        print("firmware: secrets file is missing or invalid YAML; its contents were not printed.", file=sys.stderr)
        return 1

    for config in args.configs:
        print(f"firmware: validating {config}", flush=True)
        try:
            result = subprocess.run(
                [args.esphome, "config", config],
                capture_output=True, text=True, timeout=180, check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            print("firmware: ESPHome could not complete validation; check its installation and network access.",
                  file=sys.stderr)
            return 1
        if result.returncode:
            print(redact(result.stdout + result.stderr, secrets), file=sys.stderr, end="")
            print(f"\nfirmware: validation failed for {config}", file=sys.stderr)
            return 1
        # Successful stdout is the entire expanded config, not a diagnostic.
        print(f"firmware: {config} valid")
    return 0


if __name__ == "__main__":
    sys.exit(main())
