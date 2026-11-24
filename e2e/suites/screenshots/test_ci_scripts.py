"""Tests for the CI helper scripts under e2e/suites/screenshots/ci/."""

import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import textwrap
import unittest

CI_DIR = Path(__file__).parent / "ci"
CREATE_SIMULATOR = CI_DIR / "create-simulator.py"
PRUNE_CACHE = CI_DIR / "prune-build-cache.py"
RESOLVE_REFS = CI_DIR / "resolve-refs.sh"


def install_fake_xcrun(tmp: Path, simctl_payload: dict, udid: str = "SIM-UDID-123"):
    bin_dir = tmp / "bin"
    bin_dir.mkdir()
    payload_file = tmp / "simctl.json"
    payload_file.write_text(json.dumps(simctl_payload))
    calls_file = tmp / "calls.json"
    xcrun = bin_dir / "xcrun"
    xcrun.write_text(
        textwrap.dedent(
            f"""\
            #!/usr/bin/env python3
            import json
            import sys
            from pathlib import Path

            args = sys.argv[1:]
            calls_path = Path({str(calls_file)!r})
            calls = json.loads(calls_path.read_text()) if calls_path.exists() else []
            calls.append(args)
            calls_path.write_text(json.dumps(calls))

            if args[:3] == ["simctl", "list", "-j"]:
                print(Path({str(payload_file)!r}).read_text())
            elif args[:2] == ["simctl", "create"]:
                print({udid!r})
            else:
                raise SystemExit(f"unexpected xcrun args: {{args}}")
            """
        )
    )
    xcrun.chmod(xcrun.stat().st_mode | stat.S_IXUSR)
    return bin_dir, calls_file


def run_create_simulator(bin_dir: Path, *args: str) -> subprocess.CompletedProcess:
    env = {**os.environ, "PATH": f"{bin_dir}:{os.environ.get('PATH', '')}"}
    return subprocess.run(
        [sys.executable, str(CREATE_SIMULATOR), *args],
        env=env,
        capture_output=True,
        text=True,
    )


class CreateSimulatorTest(unittest.TestCase):
    def test_ios_picks_newest_available_runtime_and_preferred_iphone(self):
        payload = {
            "runtimes": [
                {
                    "identifier": "com.apple.CoreSimulator.SimRuntime.iOS-18-0",
                    "platform": "iOS",
                    "version": "18.0",
                    "isAvailable": True,
                    "supportedDeviceTypes": [
                        {"name": "iPhone 15", "identifier": "type.iphone15"},
                        {"name": "iPhone 16", "identifier": "type.iphone16"},
                    ],
                },
                {
                    "identifier": "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
                    "platform": "iOS",
                    "version": "26.0",
                    "isAvailable": False,
                    "supportedDeviceTypes": [
                        {"name": "iPhone 17", "identifier": "type.iphone17"},
                    ],
                },
                {
                    "identifier": "com.apple.CoreSimulator.SimRuntime.iOS-18-4",
                    "platform": "iOS",
                    "version": "18.4",
                    "isAvailable": True,
                    "supportedDeviceTypes": [
                        {"name": "iPhone 15", "identifier": "type.iphone15"},
                        {"name": "iPhone 16", "identifier": "type.iphone16"},
                        {"name": "iPhone 17", "identifier": "type.iphone17"},
                    ],
                },
            ]
        }
        with tempfile.TemporaryDirectory() as tmp:
            bin_dir, calls_file = install_fake_xcrun(Path(tmp), payload, "UDID-IOS")
            res = run_create_simulator(bin_dir, "ios")
            self.assertEqual(res.returncode, 0, res.stderr)
            self.assertEqual(res.stdout.strip(), "UDID-IOS")
            calls = json.loads(calls_file.read_text())
            self.assertEqual(
                calls[1],
                [
                    "simctl",
                    "create",
                    "e2e-screenshots-ios",
                    "type.iphone16",
                    "com.apple.CoreSimulator.SimRuntime.iOS-18-4",
                ],
            )

    def test_ios_falls_back_to_any_iphone_and_top_level_devicetypes(self):
        payload = {
            "runtimes": [
                {
                    "identifier": "com.apple.CoreSimulator.SimRuntime.iOS-18-2",
                    "version": "18.2",
                    "isAvailable": True,
                }
            ],
            "devicetypes": [
                {"name": "iPad Pro", "identifier": "type.ipad"},
                {"name": "iPhone SE (3rd generation)", "identifier": "type.iphonese"},
            ],
        }
        with tempfile.TemporaryDirectory() as tmp:
            bin_dir, calls_file = install_fake_xcrun(Path(tmp), payload, "UDID-SE")
            res = run_create_simulator(bin_dir, "ios")
            self.assertEqual(res.returncode, 0, res.stderr)
            self.assertEqual(res.stdout.strip(), "UDID-SE")
            calls = json.loads(calls_file.read_text())
            self.assertEqual(calls[1][3], "type.iphonese")

    def test_apple_tv_prefers_4k_3rd_gen_on_newest_tvos_runtime(self):
        payload = {
            "runtimes": [
                {
                    "identifier": "com.apple.CoreSimulator.SimRuntime.iOS-18-4",
                    "platform": "iOS",
                    "version": "18.4",
                    "isAvailable": True,
                    "supportedDeviceTypes": [
                        {"name": "iPhone 16", "identifier": "type.iphone16"},
                    ],
                },
                {
                    "identifier": "com.apple.CoreSimulator.SimRuntime.tvOS-18-2",
                    "platform": "tvOS",
                    "version": "18.2",
                    "isAvailable": True,
                    "supportedDeviceTypes": [
                        {"name": "Apple TV", "identifier": "type.atv"},
                        {
                            "name": "Apple TV 4K (3rd generation)",
                            "identifier": "type.atv4k3",
                        },
                    ],
                },
            ]
        }
        with tempfile.TemporaryDirectory() as tmp:
            bin_dir, calls_file = install_fake_xcrun(Path(tmp), payload, "UDID-ATV")
            res = run_create_simulator(bin_dir, "apple-tv")
            self.assertEqual(res.returncode, 0, res.stderr)
            self.assertEqual(res.stdout.strip(), "UDID-ATV")
            calls = json.loads(calls_file.read_text())
            self.assertEqual(
                calls[1],
                [
                    "simctl",
                    "create",
                    "e2e-screenshots-apple-tv",
                    "type.atv4k3",
                    "com.apple.CoreSimulator.SimRuntime.tvOS-18-2",
                ],
            )

    def test_apple_tv_falls_back_to_any_apple_tv_model(self):
        payload = {
            "runtimes": [
                {
                    "identifier": "com.apple.CoreSimulator.SimRuntime.tvOS-18-0",
                    "version": "18.0",
                    "isAvailable": True,
                    "supportedDeviceTypes": [
                        {
                            "name": "Apple TV 4K (2nd generation)",
                            "identifier": "type.atv4k2",
                        }
                    ],
                }
            ]
        }
        with tempfile.TemporaryDirectory() as tmp:
            bin_dir, calls_file = install_fake_xcrun(Path(tmp), payload, "UDID-ATV2")
            res = run_create_simulator(bin_dir, "apple-tv")
            self.assertEqual(res.returncode, 0, res.stderr)
            calls = json.loads(calls_file.read_text())
            self.assertEqual(calls[1][3], "type.atv4k2")

    def test_fails_when_runtime_or_platform_invalid(self):
        with tempfile.TemporaryDirectory() as tmp:
            bin_dir, _ = install_fake_xcrun(Path(tmp), {"runtimes": []})
            missing = run_create_simulator(bin_dir, "apple-tv")
            self.assertNotEqual(missing.returncode, 0)
            self.assertIn("tvOS", missing.stderr)

            bad_arg = run_create_simulator(bin_dir, "android")
            self.assertNotEqual(bad_arg.returncode, 0)


class PruneBuildCacheTest(unittest.TestCase):
    def test_keeps_four_newest_entries_by_mtime(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "build-cache"
            platform_dir = root / "android"
            platform_dir.mkdir(parents=True)
            for idx in range(6):
                entry = platform_dir / f"hash-{idx}"
                entry.mkdir()
                mtime = 1_700_000_000 + idx * 10
                os.utime(entry, (mtime, mtime))

            res = subprocess.run(
                [sys.executable, str(PRUNE_CACHE), str(root)],
                capture_output=True,
                text=True,
            )
            self.assertEqual(res.returncode, 0, res.stderr)
            remaining = sorted(p.name for p in platform_dir.iterdir())
            self.assertEqual(remaining, ["hash-2", "hash-3", "hash-4", "hash-5"])

    def test_missing_root_is_a_noop(self):
        with tempfile.TemporaryDirectory() as tmp:
            res = subprocess.run(
                [sys.executable, str(PRUNE_CACHE), str(Path(tmp) / "missing")],
                capture_output=True,
                text=True,
            )
            self.assertEqual(res.returncode, 0, res.stderr)


def git(cwd: Path, *args: str) -> str:
    return subprocess.check_output(
        ["git", *args],
        cwd=cwd,
        text=True,
        stderr=subprocess.STDOUT,
    ).strip()


class ResolveRefsTest(unittest.TestCase):
    def _init_repo(self, tmp: Path) -> tuple[Path, Path, str, str]:
        remote = tmp / "remote.git"
        work = tmp / "work"
        git(tmp, "init", "--bare", str(remote))
        git(tmp, "clone", str(remote), str(work))
        git(work, "config", "user.name", "Test")
        git(work, "config", "user.email", "test@example.com")

        git(work, "checkout", "-b", "develop")
        (work / "file.txt").write_text("base\n")
        git(work, "add", "file.txt")
        git(work, "commit", "-m", "base")
        base_sha = git(work, "rev-parse", "HEAD")
        git(work, "push", "-u", "origin", "develop")

        git(work, "checkout", "-b", "feat/change")
        (work / "file.txt").write_text("head\n")
        git(work, "add", "file.txt")
        git(work, "commit", "-m", "head")
        head_sha = git(work, "rev-parse", "HEAD")
        return remote, work, base_sha, head_sha

    def _run_resolve(self, work: Path, extra_env: dict[str, str]):
        env_file = work / "github_env"
        env_file.write_text("")
        env = {
            **os.environ,
            "GITHUB_ENV": str(env_file),
            **extra_env,
        }
        res = subprocess.run(
            ["bash", str(RESOLVE_REFS)],
            cwd=work,
            env=env,
            capture_output=True,
            text=True,
        )
        parsed = dict(
            line.split("=", 1)
            for line in env_file.read_text().splitlines()
            if "=" in line
        )
        return res, parsed

    def test_pull_request_resolves_base_and_head(self):
        with tempfile.TemporaryDirectory() as tmp:
            _, work, _, head_sha = self._init_repo(Path(tmp))
            res, env_out = self._run_resolve(
                work,
                {
                    "EVENT_NAME": "pull_request",
                    "PR_BASE_REF": "develop",
                    "PR_HEAD_SHA": head_sha,
                },
            )
            self.assertEqual(res.returncode, 0, res.stderr)
            self.assertEqual(env_out["BEFORE_REF"], "origin/develop")
            self.assertEqual(env_out["AFTER_REF"], head_sha)

    def test_dispatch_defaults_after_to_dispatch_sha_and_fetches_remote_branch(self):
        with tempfile.TemporaryDirectory() as tmp:
            remote, work, _, head_sha = self._init_repo(Path(tmp))
            # Push a branch from a second clone so `work` does not have it locally.
            other = Path(tmp) / "other"
            git(Path(tmp), "clone", str(remote), str(other))
            git(other, "config", "user.name", "Test")
            git(other, "config", "user.email", "test@example.com")
            git(other, "checkout", "-b", "master", "origin/develop")
            (other / "other.txt").write_text("master\n")
            git(other, "add", "other.txt")
            git(other, "commit", "-m", "master")
            git(other, "push", "origin", "master")

            res, env_out = self._run_resolve(
                work,
                {
                    "EVENT_NAME": "workflow_dispatch",
                    "INPUT_BEFORE": "master",
                    "INPUT_AFTER": "",
                    "DISPATCH_SHA": head_sha,
                },
            )
            self.assertEqual(res.returncode, 0, res.stderr)
            self.assertEqual(env_out["BEFORE_REF"], "origin/master")
            self.assertEqual(env_out["AFTER_REF"], head_sha)

    def test_unknown_ref_fails_clearly(self):
        with tempfile.TemporaryDirectory() as tmp:
            _, work, _, head_sha = self._init_repo(Path(tmp))
            res, _ = self._run_resolve(
                work,
                {
                    "EVENT_NAME": "workflow_dispatch",
                    "INPUT_BEFORE": "does-not-exist",
                    "INPUT_AFTER": head_sha,
                    "DISPATCH_SHA": head_sha,
                },
            )
            self.assertNotEqual(res.returncode, 0)
            self.assertIn("Could not resolve ref", res.stderr)


if __name__ == "__main__":
    unittest.main()
