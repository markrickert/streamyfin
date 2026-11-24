"""Tests for the CI helper scripts under e2e/suites/screenshots/ci/."""

import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tarfile
import tempfile
import textwrap
import unittest

CI_DIR = Path(__file__).parent / "ci"
CREATE_SIMULATOR = CI_DIR / "create-simulator.py"
FETCH_DEV_CLIENT = CI_DIR / "fetch-dev-client.py"
PREPARE_UPLOADS = CI_DIR / "prepare-dev-client-uploads.py"
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


def install_fake_gh(
    tmp: Path,
    artifacts_payload: dict,
    download_files: dict[str, bytes] | None = None,
    download_exit: int = 0,
):
    bin_dir = tmp / "bin"
    bin_dir.mkdir(exist_ok=True)
    payload_file = tmp / "artifacts.json"
    payload_file.write_text(json.dumps(artifacts_payload))
    calls_file = tmp / "gh_calls.json"
    download_dir = tmp / "download_fixture"
    download_dir.mkdir(exist_ok=True)
    for rel, data in (download_files or {}).items():
        target = download_dir / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)

    gh = bin_dir / "gh"
    gh.write_text(
        textwrap.dedent(
            f"""\
            #!/usr/bin/env python3
            import json
            import shutil
            import sys
            from pathlib import Path

            args = sys.argv[1:]
            calls_path = Path({str(calls_file)!r})
            calls = json.loads(calls_path.read_text()) if calls_path.exists() else []
            calls.append(args)
            calls_path.write_text(json.dumps(calls))

            if args and args[0] == "api":
                print(Path({str(payload_file)!r}).read_text())
            elif args[:2] == ["run", "download"]:
                if {download_exit} != 0:
                    sys.stderr.write("download failed\\n")
                    raise SystemExit({download_exit})
                dest = Path(args[args.index("-D") + 1])
                shutil.copytree({str(download_dir)!r}, dest, dirs_exist_ok=True)
            else:
                raise SystemExit(f"unexpected gh args: {{args}}")
            """
        )
    )
    gh.chmod(gh.stat().st_mode | stat.S_IXUSR)
    return bin_dir, calls_file


def make_tar_bytes(entries: list[tuple[str, bytes, int | None, str | None]]) -> bytes:
    """Build an in-memory tar archive from (name, content, mode, linkname) tuples."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tf:
        for name, data, mode, linkname in entries:
            info = tarfile.TarInfo(name)
            if linkname is not None:
                info.type = tarfile.SYMTYPE
                info.linkname = linkname
                tf.addfile(info)
            else:
                info.size = len(data)
                if mode is not None:
                    info.mode = mode
                tf.addfile(info, io.BytesIO(data))
    return buf.getvalue()


class FetchDevClientTest(unittest.TestCase):
    def _run_fetch(
        self,
        bin_dir: Path,
        platform: str,
        fp_hash: str,
        cache_dir: Path,
        extra_env: dict[str, str] | None = None,
    ) -> subprocess.CompletedProcess:
        env = {
            **os.environ,
            "PATH": f"{bin_dir}:{os.environ.get('PATH', '')}",
            "GITHUB_REPOSITORY": "streamyfin/streamyfin",
            "GITHUB_REPOSITORY_ID": "100",
            **(extra_env or {}),
        }
        return subprocess.run(
            [sys.executable, str(FETCH_DEV_CLIENT), platform, fp_hash, str(cache_dir)],
            env=env,
            capture_output=True,
            text=True,
        )

    def _trusted_payload(self, artifact_name: str, run_id: int = 9004) -> dict:
        return {
            "total_count": 1,
            "artifacts": [
                {
                    "id": 1,
                    "name": artifact_name,
                    "expired": False,
                    "created_at": "2026-11-24T02:00:00Z",
                    "workflow_run": {"id": run_id, "head_repository_id": 100},
                }
            ],
        }

    def test_picks_newest_trusted_non_expired_artifact_and_downloads_into_cache(self):
        name = "shots-dev-client-ios-fp123"
        payload = {
            "total_count": 4,
            "artifacts": [
                {
                    "id": 1,
                    "name": name,
                    "expired": False,
                    "created_at": "2026-11-24T04:00:00Z",
                    "workflow_run": {"id": 9001, "head_repository_id": 999},
                },
                {
                    "id": 2,
                    "name": name,
                    "expired": True,
                    "created_at": "2026-11-24T03:00:00Z",
                    "workflow_run": {"id": 9002, "head_repository_id": 100},
                },
                {
                    "id": 3,
                    "name": name,
                    "expired": False,
                    "created_at": "2026-11-24T01:00:00Z",
                    "workflow_run": {"id": 9003, "head_repository_id": 100},
                },
                {
                    "id": 4,
                    "name": name,
                    "expired": False,
                    "created_at": "2026-11-24T02:00:00Z",
                    "workflow_run": {"id": 9004, "head_repository_id": 100},
                },
            ],
        }
        tar_bytes = make_tar_bytes([("Streamyfin.app/Info.plist", b"plist", 0o644, None)])
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            bin_dir, calls_file = install_fake_gh(
                tmp_path,
                payload,
                download_files={f"{name}.tar": tar_bytes},
            )
            cache_dir = tmp_path / "build-cache" / "ios" / "fp123"
            res = self._run_fetch(bin_dir, "ios", "fp123", cache_dir)
            self.assertEqual(res.returncode, 0, res.stderr)
            self.assertTrue((cache_dir / "Streamyfin.app" / "Info.plist").is_file())
            calls = json.loads(calls_file.read_text())
            self.assertEqual(calls[0][0], "api")
            self.assertIn(f"repos/streamyfin/streamyfin/actions/artifacts?name={name}", calls[0][1])
            self.assertEqual(
                calls[1],
                ["run", "download", "9004", "-R", "streamyfin/streamyfin", "-n", name, "-D", calls[1][calls[1].index("-D") + 1]],
            )

    def test_round_trip_app_preserves_executable_mode_and_relative_symlinks(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            built_cache = tmp_path / "built" / "ios" / "fpapp"
            app = built_cache / "Streamyfin.app"
            (app / "Frameworks" / "Foo.framework" / "Versions" / "A").mkdir(parents=True)
            (app / "PlugIns").mkdir(parents=True)
            (app / "Info.plist").write_bytes(b"plist")
            binary = app / "Streamyfin"
            binary.write_bytes(b"#!/bin/sh\necho hi\n")
            binary.chmod(0o755)
            fw_bin = app / "Frameworks" / "Foo.framework" / "Versions" / "A" / "Foo"
            fw_bin.write_bytes(b"framework-bin")
            fw_bin.chmod(0o755)
            os.symlink("A", app / "Frameworks" / "Foo.framework" / "Versions" / "Current")
            os.symlink("Versions/Current/Foo", app / "Frameworks" / "Foo.framework" / "Foo")
            os.symlink("../Frameworks/Foo.framework/Foo", app / "PlugIns" / "Bar")

            manifest = tmp_path / "build-cache.json"
            manifest.write_text(
                json.dumps(
                    [
                        {
                            "ref": "after",
                            "platform": "ios",
                            "hash": "fpapp",
                            "source": "built",
                            "path": str(app),
                        }
                    ]
                )
            )
            staging = tmp_path / "staging"
            prep = subprocess.run(
                [
                    sys.executable,
                    str(PREPARE_UPLOADS),
                    str(manifest),
                    "--staging-dir",
                    str(staging),
                ],
                capture_output=True,
                text=True,
            )
            self.assertEqual(prep.returncode, 0, prep.stderr)
            parsed = dict(
                line.split("=", 1) for line in prep.stdout.splitlines() if "=" in line
            )
            tar_path = Path(parsed["after_path"])
            self.assertEqual(tar_path, staging / "shots-dev-client-ios-fpapp.tar")
            self.assertTrue(tar_path.is_file())

            name = "shots-dev-client-ios-fpapp"
            bin_dir, _ = install_fake_gh(
                tmp_path,
                self._trusted_payload(name),
                download_files={tar_path.name: tar_path.read_bytes()},
            )
            fetched_cache = tmp_path / "fetched" / "ios" / "fpapp"
            res = self._run_fetch(bin_dir, "ios", "fpapp", fetched_cache)
            self.assertEqual(res.returncode, 0, res.stderr)

            fetched_app = fetched_cache / "Streamyfin.app"
            fetched_bin = fetched_app / "Streamyfin"
            self.assertTrue(fetched_bin.is_file())
            self.assertTrue(fetched_bin.stat().st_mode & stat.S_IXUSR)
            self.assertEqual(fetched_bin.read_bytes(), b"#!/bin/sh\necho hi\n")

            current_link = fetched_app / "Frameworks" / "Foo.framework" / "Versions" / "Current"
            fw_link = fetched_app / "Frameworks" / "Foo.framework" / "Foo"
            plugin_link = fetched_app / "PlugIns" / "Bar"
            self.assertTrue(current_link.is_symlink())
            self.assertTrue(fw_link.is_symlink())
            self.assertTrue(plugin_link.is_symlink())
            self.assertEqual(os.readlink(current_link), "A")
            self.assertEqual(os.readlink(fw_link), "Versions/Current/Foo")
            self.assertEqual(os.readlink(plugin_link), "../Frameworks/Foo.framework/Foo")
            self.assertEqual(plugin_link.read_bytes(), b"framework-bin")

    def test_round_trip_apk(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            built_cache = tmp_path / "built" / "android" / "fpapk"
            built_cache.mkdir(parents=True)
            apk = built_cache / "app-debug.apk"
            apk.write_bytes(b"PK\x03\x04fake-apk-bytes")

            manifest = tmp_path / "build-cache.json"
            manifest.write_text(
                json.dumps(
                    [
                        {
                            "ref": "before",
                            "platform": "android",
                            "hash": "fpapk",
                            "source": "built",
                            "path": str(apk),
                        }
                    ]
                )
            )
            staging = tmp_path / "staging"
            prep = subprocess.run(
                [
                    sys.executable,
                    str(PREPARE_UPLOADS),
                    str(manifest),
                    "--staging-dir",
                    str(staging),
                ],
                capture_output=True,
                text=True,
            )
            self.assertEqual(prep.returncode, 0, prep.stderr)
            parsed = dict(
                line.split("=", 1) for line in prep.stdout.splitlines() if "=" in line
            )
            tar_path = Path(parsed["before_path"])
            self.assertEqual(tar_path, staging / "shots-dev-client-android-fpapk.tar")

            name = "shots-dev-client-android-fpapk"
            bin_dir, _ = install_fake_gh(
                tmp_path,
                self._trusted_payload(name),
                download_files={tar_path.name: tar_path.read_bytes()},
            )
            fetched_cache = tmp_path / "fetched" / "android" / "fpapk"
            res = self._run_fetch(bin_dir, "android", "fpapk", fetched_cache)
            self.assertEqual(res.returncode, 0, res.stderr)
            fetched_apk = fetched_cache / "app-debug.apk"
            self.assertTrue(fetched_apk.is_file())
            self.assertEqual(fetched_apk.read_bytes(), b"PK\x03\x04fake-apk-bytes")

    def test_refuses_tar_with_parent_traversal_or_absolute_path_and_installs_nothing(self):
        cases = [
            (
                "parent_traversal",
                [
                    ("Streamyfin.app/Info.plist", b"plist", 0o644, None),
                    ("../escape.txt", b"pwn", 0o644, None),
                ],
            ),
            (
                "absolute_path",
                [
                    ("Streamyfin.app/Info.plist", b"plist", 0o644, None),
                    ("/tmp/abs.txt", b"pwn", 0o644, None),
                ],
            ),
            (
                "escaping_symlink",
                [
                    ("Streamyfin.app/Info.plist", b"plist", 0o644, None),
                    ("Streamyfin.app/bad", b"", None, "../../outside"),
                ],
            ),
        ]
        for label, entries in cases:
            with self.subTest(label=label), tempfile.TemporaryDirectory() as tmp:
                tmp_path = Path(tmp)
                name = "shots-dev-client-ios-fpbad"
                bin_dir, _ = install_fake_gh(
                    tmp_path,
                    self._trusted_payload(name),
                    download_files={f"{name}.tar": make_tar_bytes(entries)},
                )
                cache_dir = tmp_path / "build-cache" / "ios" / "fpbad"
                res = self._run_fetch(bin_dir, "ios", "fpbad", cache_dir)
                self.assertNotEqual(res.returncode, 0)
                self.assertFalse(cache_dir.exists())
                self.assertFalse((tmp_path / "build-cache" / "ios" / "escape.txt").exists())
                self.assertEqual(len(res.stderr.strip().splitlines()), 1)

    def test_rejects_unexpected_download_contents_and_installs_nothing(self):
        name = "shots-dev-client-android-fpextra"
        tar_bytes = make_tar_bytes([("app-debug.apk", b"apk", 0o644, None)])
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            bin_dir, _ = install_fake_gh(
                tmp_path,
                self._trusted_payload(name),
                download_files={f"{name}.tar": tar_bytes, "extra.txt": b"unexpected"},
            )
            cache_dir = tmp_path / "build-cache" / "android" / "fpextra"
            res = self._run_fetch(bin_dir, "android", "fpextra", cache_dir)
            self.assertNotEqual(res.returncode, 0)
            self.assertFalse(cache_dir.exists())
            self.assertEqual(len(res.stderr.strip().splitlines()), 1)

    def test_rejects_fork_and_expired_artifacts_with_one_line_error(self):
        name = "shots-dev-client-android-fp999"
        payload = {
            "total_count": 2,
            "artifacts": [
                {
                    "id": 1,
                    "name": name,
                    "expired": False,
                    "created_at": "2026-11-24T04:00:00Z",
                    "workflow_run": {"id": 9001, "head_repository_id": 999},
                },
                {
                    "id": 2,
                    "name": name,
                    "expired": True,
                    "created_at": "2026-11-24T03:00:00Z",
                    "workflow_run": {"id": 9002, "head_repository_id": 100},
                },
            ],
        }
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            bin_dir, calls_file = install_fake_gh(tmp_path, payload)
            cache_dir = tmp_path / "build-cache" / "android" / "fp999"
            res = self._run_fetch(bin_dir, "android", "fp999", cache_dir)
            self.assertNotEqual(res.returncode, 0)
            self.assertFalse(cache_dir.exists())
            self.assertEqual(len(res.stderr.strip().splitlines()), 1)
            calls = json.loads(calls_file.read_text())
            self.assertEqual(len(calls), 1)

    def test_download_failure_leaves_cache_empty_and_exits_nonzero_with_one_line(self):
        name = "shots-dev-client-android-fp1"
        payload = {
            "total_count": 1,
            "artifacts": [
                {
                    "id": 1,
                    "name": name,
                    "expired": False,
                    "created_at": "2026-11-24T02:00:00Z",
                    "workflow_run": {"id": 55, "head_repository_id": 100},
                }
            ],
        }
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            bin_dir, _ = install_fake_gh(tmp_path, payload, download_exit=1)
            cache_dir = tmp_path / "build-cache" / "android" / "fp1"
            res = self._run_fetch(bin_dir, "android", "fp1", cache_dir)
            self.assertNotEqual(res.returncode, 0)
            self.assertFalse(cache_dir.exists())
            self.assertEqual(len(res.stderr.strip().splitlines()), 1)


class PrepareDevClientUploadsTest(unittest.TestCase):
    def test_outputs_only_built_entries_deduplicated_by_hash(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            before_dir = tmp_path / "cache" / "ios" / "h1"
            after_dir = tmp_path / "cache" / "ios" / "h2"
            before_dir.mkdir(parents=True)
            (after_dir / "Streamyfin.app").mkdir(parents=True)
            (after_dir / "Streamyfin.app" / "Info.plist").write_text("plist")
            staging = tmp_path / "staging"
            manifest = tmp_path / "build-cache.json"
            manifest.write_text(
                json.dumps(
                    [
                        {
                            "ref": "before",
                            "platform": "ios",
                            "hash": "h1",
                            "source": "fetched",
                            "path": str(before_dir / "Streamyfin.app"),
                        },
                        {
                            "ref": "after",
                            "platform": "ios",
                            "hash": "h2",
                            "source": "built",
                            "path": str(after_dir / "Streamyfin.app"),
                        },
                    ]
                )
            )
            res = subprocess.run(
                [
                    sys.executable,
                    str(PREPARE_UPLOADS),
                    str(manifest),
                    "--staging-dir",
                    str(staging),
                ],
                capture_output=True,
                text=True,
            )
            self.assertEqual(res.returncode, 0, res.stderr)
            parsed = dict(
                line.split("=", 1)
                for line in res.stdout.splitlines()
                if "=" in line
            )
            self.assertEqual(parsed.get("before_hash", ""), "")
            self.assertEqual(parsed["after_hash"], "h2")
            tar_path = Path(parsed["after_path"])
            self.assertEqual(tar_path, staging / "shots-dev-client-ios-h2.tar")
            self.assertTrue(tar_path.is_file())
            with tarfile.open(tar_path, "r") as tf:
                names = tf.getnames()
            self.assertTrue(all(not n.startswith("/") and ".." not in n.split("/") for n in names))
            self.assertIn("Streamyfin.app/Info.plist", names)

    def test_ignores_local_hit_after_same_hash_built_and_uses_runner_temp(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            cache_dir = tmp_path / "cache" / "android" / "h1"
            cache_dir.mkdir(parents=True)
            (cache_dir / "app-debug.apk").write_bytes(b"apk")
            runner_temp = tmp_path / "runner_temp"
            manifest = tmp_path / "build-cache.json"
            manifest.write_text(
                json.dumps(
                    [
                        {
                            "ref": "before",
                            "platform": "android",
                            "hash": "h1",
                            "source": "built",
                            "path": str(cache_dir / "app-debug.apk"),
                        },
                        {
                            "ref": "after",
                            "platform": "android",
                            "hash": "h1",
                            "source": "local",
                            "path": str(cache_dir / "app-debug.apk"),
                        },
                    ]
                )
            )
            res = subprocess.run(
                [sys.executable, str(PREPARE_UPLOADS), str(manifest)],
                env={**os.environ, "RUNNER_TEMP": str(runner_temp)},
                capture_output=True,
                text=True,
            )
            self.assertEqual(res.returncode, 0, res.stderr)
            parsed = dict(
                line.split("=", 1)
                for line in res.stdout.splitlines()
                if "=" in line
            )
            self.assertEqual(parsed["before_hash"], "h1")
            expected_tar = runner_temp / "shots-dev-client-android-h1.tar"
            self.assertEqual(parsed["before_path"], str(expected_tar))
            self.assertTrue(expected_tar.is_file())
            self.assertEqual(parsed.get("after_hash", ""), "")


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
