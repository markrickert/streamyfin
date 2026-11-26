#!/usr/bin/env python3
"""Fetch a trusted debug dev-client artifact by native fingerprint."""

import argparse
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys
import tarfile
import tempfile
from typing import NoReturn
from urllib.parse import quote

ARTIFACT_PREFIX = "shots-dev-client-"
PLATFORMS = ("ios", "apple-tv", "android", "android-tv")


def fail(message: str) -> NoReturn:
    one_line = " ".join(str(message).splitlines()).strip() or "unknown error"
    sys.stderr.write(f"{one_line}\n")
    raise SystemExit(1)


def is_trusted_artifact(artifact: dict, artifact_name: str, repo_id: int) -> bool:
    if artifact.get("name") != artifact_name or artifact.get("expired"):
        return False
    run = artifact.get("workflow_run")
    if not isinstance(run, dict):
        return False
    return (
        run.get("head_repository_id") == repo_id
        and run.get("repository_id", repo_id) == repo_id
    )


# A fetched client is never re-uploaded, so its expiry counts from the first build:
# one dying inside the floor counts as missing, and the run rebuilds and uploads a
# fresh artifact instead of inheriting days it cannot extend.
EXPIRY_FLOOR = timedelta(days=14)


def expires_soon(artifact: dict, now: datetime) -> bool:
    raw = artifact.get("expires_at")
    if not raw:
        return False
    try:
        expiry = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except ValueError:
        return False
    return expiry - now < EXPIRY_FLOOR


def current_time() -> datetime:
    """Now in UTC; SHOTS_FETCH_NOW overrides it so the expiry floor is testable."""
    raw = os.environ.get("SHOTS_FETCH_NOW", "").strip()
    if not raw:
        return datetime.now(timezone.utc)
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        fail("SHOTS_FETCH_NOW must be an ISO-8601 timestamp")


def list_artifacts(repo: str, artifact_name: str) -> list[dict]:
    artifacts: list[dict] = []
    page = 1
    total = float("inf")
    encoded_name = quote(artifact_name, safe="")
    while len(artifacts) < total:
        endpoint = (
            f"repos/{repo}/actions/artifacts"
            f"?name={encoded_name}&per_page=100&page={page}"
        )
        res = subprocess.run(
            ["gh", "api", endpoint],
            capture_output=True,
            text=True,
        )
        if res.returncode != 0:
            fail(f"gh api failed: {res.stderr or res.stdout or f'exit {res.returncode}'}")
        try:
            body = json.loads(res.stdout)
        except json.JSONDecodeError as exc:
            fail(f"invalid gh api JSON: {exc}")
        page_items = body.get("artifacts")
        if not isinstance(page_items, list):
            fail("gh api response missing artifacts list")
        total = body.get("total_count", len(page_items))
        artifacts.extend(page_items)
        if len(page_items) < 100:
            break
        page += 1
    return artifacts


def has_expected_artifact(cache_dir: Path, platform: str) -> bool:
    if not cache_dir.is_dir():
        return False
    ext = ".apk" if platform in ("android", "android-tv") else ".app"
    matches = [p for p in cache_dir.iterdir() if p.name.endswith(ext)]
    return len(matches) == 1


def safe_data_filter(member: tarfile.TarInfo, dest_path: str) -> tarfile.TarInfo:
    # data_filter strips leading '/' instead of rejecting absolute member paths, so reject them here.
    if member.name.startswith("/") or os.path.isabs(member.name):
        raise tarfile.AbsolutePathError(member)
    if ".." in PurePosixPath(member.name).parts:
        raise tarfile.OutsideDestinationError(member, member.name)
    return tarfile.data_filter(member, dest_path)


def extract_tarball(download_dir: Path, extract_dir: Path, expected_tar: str) -> None:
    entries = list(download_dir.iterdir())
    if len(entries) != 1 or entries[0].name != expected_tar or not entries[0].is_file():
        found = ", ".join(sorted(p.name for p in entries)) or "none"
        fail(f"expected single tarball {expected_tar} in download, found: {found}")
    try:
        with tarfile.open(entries[0], "r:*") as tf:
            tf.extractall(extract_dir, filter=safe_data_filter)
    except (tarfile.TarError, OSError) as exc:
        fail(f"failed to extract {expected_tar}: {exc}")


def fetch_dev_client(platform: str, fp_hash: str, cache_dir: Path) -> None:
    repo = os.environ.get("GITHUB_REPOSITORY", "").strip()
    if not repo:
        fail("GITHUB_REPOSITORY is not set")
    raw_repo_id = os.environ.get("GITHUB_REPOSITORY_ID", "").strip()
    try:
        repo_id = int(raw_repo_id)
    except ValueError:
        fail("GITHUB_REPOSITORY_ID must be an integer")

    artifact_name = f"{ARTIFACT_PREFIX}{platform}-{fp_hash}"
    artifacts = list_artifacts(repo, artifact_name)
    now = current_time()
    trusted = [
        a
        for a in artifacts
        if is_trusted_artifact(a, artifact_name, repo_id)
        and not expires_soon(a, now)
    ]
    if not trusted:
        fail(f"no trusted non-expired artifact named {artifact_name}")

    trusted.sort(key=lambda a: a.get("created_at") or "", reverse=True)
    chosen = trusted[0]
    run_id = chosen.get("workflow_run", {}).get("id")
    if not run_id:
        fail(f"artifact {artifact_name} is missing workflow_run.id")

    cache_dir.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=cache_dir.parent) as tmp:
        download_dir = Path(tmp) / "download"
        download_dir.mkdir()
        extract_dir = Path(tmp) / "extracted"
        extract_dir.mkdir()
        res = subprocess.run(
            [
                "gh",
                "run",
                "download",
                str(run_id),
                "-R",
                repo,
                "-n",
                artifact_name,
                "-D",
                str(download_dir),
            ],
            capture_output=True,
            text=True,
        )
        if res.returncode != 0:
            fail(
                f"gh run download failed for {artifact_name} (run {run_id}): "
                f"{res.stderr or res.stdout or f'exit {res.returncode}'}"
            )
        extract_tarball(download_dir, extract_dir, f"{artifact_name}.tar")
        if not has_expected_artifact(extract_dir, platform):
            fail(f"downloaded artifact {artifact_name} did not contain expected binary")
        if cache_dir.exists():
            shutil.rmtree(cache_dir)
        shutil.move(str(extract_dir), str(cache_dir))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Download a trusted debug dev client artifact by fingerprint."
    )
    parser.add_argument("platform", choices=PLATFORMS)
    parser.add_argument("hash")
    parser.add_argument("cache_dir", type=Path)
    args = parser.parse_args(argv)
    fetch_dev_client(args.platform, args.hash, args.cache_dir)
    return 0


if __name__ == "__main__":
    sys.exit(main())
