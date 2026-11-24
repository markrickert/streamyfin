#!/usr/bin/env python3
"""Read build-cache.json, tar built dev clients, and emit GITHUB_OUTPUT pairs."""

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

SLOTS = ("before", "after")


def artifact_folder(entry_path: Path) -> Path:
    if entry_path.is_dir() and entry_path.suffix != ".app":
        return entry_path
    return entry_path.parent


def resolve_staging_dir(staging_dir: Path | None) -> Path:
    if staging_dir is not None:
        return staging_dir
    runner_temp = os.environ.get("RUNNER_TEMP", "").strip()
    if runner_temp:
        return Path(runner_temp)
    return Path(tempfile.gettempdir())


def pack_tarball(folder: Path, tar_path: Path) -> None:
    tar_path.parent.mkdir(parents=True, exist_ok=True)
    entries = sorted(p.name for p in folder.iterdir())
    targets = entries or ["."]
    env = {**os.environ, "COPYFILE_DISABLE": "1"}
    subprocess.run(
        ["tar", "-cf", str(tar_path), "-C", str(folder), *targets],
        check=True,
        env=env,
    )


def collect_uploads(
    manifest_path: Path, staging_dir: Path | None = None
) -> dict[str, tuple[str, str]]:
    if not manifest_path.is_file():
        return {}
    entries = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(entries, list):
        raise SystemExit(f"Expected a JSON list in {manifest_path}")

    resolved_staging = resolve_staging_dir(staging_dir)
    uploads: dict[str, tuple[str, str]] = {}
    seen_keys: set[tuple[str, str]] = set()
    for entry in entries:
        if entry.get("source") != "built":
            continue
        platform = str(entry.get("platform", ""))
        fp_hash = str(entry.get("hash", ""))
        raw_path = entry.get("path")
        if not platform or not fp_hash or not raw_path:
            continue
        key = (platform, fp_hash)
        if key in seen_keys:
            continue
        folder = artifact_folder(Path(raw_path))
        if not folder.is_dir():
            continue
        ref = entry.get("ref")
        slot = ref if ref in SLOTS and ref not in uploads else next(
            (s for s in SLOTS if s not in uploads), None
        )
        if slot is None:
            continue
        seen_keys.add(key)
        tar_path = resolved_staging / f"shots-dev-client-{platform}-{fp_hash}.tar"
        pack_tarball(folder, tar_path)
        uploads[slot] = (fp_hash, str(tar_path))
    return uploads


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Emit before/after artifact hashes and tarballs for built dev clients."
    )
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--staging-dir", type=Path, default=None)
    args = parser.parse_args(argv)

    uploads = collect_uploads(args.manifest, args.staging_dir)
    for slot in SLOTS:
        fp_hash, tar_path = uploads.get(slot, ("", ""))
        print(f"{slot}_hash={fp_hash}")
        print(f"{slot}_path={tar_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
