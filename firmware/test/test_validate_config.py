"""Execute the validator with a fake ESPHome process, including both output streams."""

from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


VALIDATOR = Path(__file__).resolve().parents[1] / "tools" / "validate-config.py"


class ValidatorTest(unittest.TestCase):
    def run_validator(self, *, fail=False, bad_secrets=False):
        with tempfile.TemporaryDirectory(prefix="onair-validator-") as directory:
            root = Path(directory)
            secret = "credential-that-must-never-be-printed"
            secrets = root / "secrets.yaml"
            secrets.write_text("password: [" + secret if bad_secrets else f'password: "{secret}"\n')
            fake = root / "esphome"
            fake.write_text(
                f"#!{sys.executable}\n"
                "import sys\n"
                f"print('Failed config: invalid encryption key, {secret}')\n"
                f"print('stderr credential: {secret}', file=sys.stderr)\n"
                f"sys.exit({2 if fail else 0})\n"
            )
            fake.chmod(0o700)
            result = subprocess.run(
                [sys.executable, str(VALIDATOR), "--esphome", str(fake),
                 "--secrets", str(secrets), "configs/example.yaml"],
                capture_output=True, text=True, check=False,
            )
            return result, secret

    def test_failure_keeps_diagnostic_and_redacts_both_streams(self):
        result, secret = self.run_validator(fail=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("invalid encryption key", result.stderr)
        self.assertIn("stderr credential: <REDACTED>", result.stderr)
        self.assertNotIn(secret, result.stdout + result.stderr)

    def test_success_never_prints_resolved_configuration(self):
        result, secret = self.run_validator()
        self.assertEqual(result.returncode, 0)
        self.assertIn("configs/example.yaml valid", result.stdout)
        self.assertNotIn("invalid encryption key", result.stdout + result.stderr)
        self.assertNotIn(secret, result.stdout + result.stderr)

    def test_bad_secrets_does_not_print_yaml_exception_or_run_esphome(self):
        result, secret = self.run_validator(bad_secrets=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("invalid YAML", result.stderr)
        self.assertNotIn("stderr credential", result.stderr)
        self.assertNotIn(secret, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
