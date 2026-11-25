"""run.sh's env contract: MAESTRO_* variables must reach Maestro as --env arguments."""

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

RUN_SH = Path(__file__).parent / "run.sh"

FAKE_MAESTRO = """#!/usr/bin/env python3
import json
import sys
print(json.dumps(sys.argv[1:]))
"""


def sandboxed_run_sh(tmpdir):
    """A copy of run.sh with a stub flows dir and a maestro.py that echoes argv."""
    suite = Path(tmpdir)
    shutil.copy(RUN_SH, suite / "run.sh")
    (suite / "flows").mkdir()
    for flow in ("mobile", "bootstrap-login-mobile", "seerr-mobile"):
        (suite / "flows" / f"{flow}.yml").write_text("appId: x\n---\n[]\n")
    (suite / "maestro.py").write_text(FAKE_MAESTRO)
    return suite


def invoke(suite, flow, env):
    result = subprocess.run(
        ["bash", str(suite / "run.sh"), flow, str(suite / "out")],
        env=env, capture_output=True, text=True, check=True,
    )
    # Nothing but the stub's argv print may reach stdout — secrets are never echoed.
    return json.loads(result.stdout), result.stderr


def env_args(args):
    return dict(args[i].split("=", 1) for i in range(1, len(args)) if args[i - 1] == "--env")


class RunShEnvContractTest(unittest.TestCase):
    def test_maestro_vars_are_forwarded_as_env_args(self):
        with tempfile.TemporaryDirectory() as tmp:
            suite = sandboxed_run_sh(tmp)
            env = {
                **os.environ,
                "MAESTRO_JELLYFIN_URL": "http://127.0.0.1:18096",
                "MAESTRO_JELLYFIN_USER": "syncplay-host",
                "MAESTRO_JELLYFIN_PASS": "s3cret-fixture-password",
            }
            args, stderr = invoke(suite, "bootstrap-login-mobile", env)
            forwarded = env_args(args)
            self.assertEqual(forwarded, {
                "MAESTRO_JELLYFIN_URL": "http://127.0.0.1:18096",
                "MAESTRO_JELLYFIN_USER": "syncplay-host",
                "MAESTRO_JELLYFIN_PASS": "s3cret-fixture-password",
            })
            self.assertIn("--flow", args)
            self.assertNotIn("s3cret-fixture-password", stderr)

    def test_a_flow_with_no_required_env_still_forwards_set_vars(self):
        with tempfile.TemporaryDirectory() as tmp:
            suite = sandboxed_run_sh(tmp)
            env = {**os.environ, "MAESTRO_APP_ID": "com.example.dev"}
            args, _ = invoke(suite, "mobile", env)
            self.assertEqual(env_args(args), {"MAESTRO_APP_ID": "com.example.dev"})

    def test_missing_required_var_refuses_before_running_maestro(self):
        with tempfile.TemporaryDirectory() as tmp:
            suite = sandboxed_run_sh(tmp)
            result = subprocess.run(
                ["bash", str(suite / "run.sh"), "bootstrap-login-mobile", str(suite / "out")],
                env=dict(os.environ), capture_output=True, text=True,
            )
            self.assertEqual(result.returncode, 2)
            self.assertIn("MAESTRO_JELLYFIN_URL", result.stderr)


if __name__ == "__main__":
    unittest.main()
