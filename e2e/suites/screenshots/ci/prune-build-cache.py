#!/usr/bin/env python3
"""Keep only the newest N debug build-cache entries by mtime."""

import argparse
from pathlib import Path
import shutil
import sys

DEFAULT_ROOT = Path("e2e/reports/shots/build-cache")
DEFAULT_KEEP = 4


def prune_build_cache(
    root: Path = DEFAULT_ROOT, keep: int = DEFAULT_KEEP
) -> list[Path]:
    if not root.is_dir():
        return []
    entries = [
        entry
        for platform_dir in root.iterdir()
        if platform_dir.is_dir()
        for entry in platform_dir.iterdir()
        if entry.is_dir()
    ]
    entries.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    removed = []
    for stale in entries[keep:]:
        shutil.rmtree(stale)
        removed.append(stale)
    return removed


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Prune unused debug build-cache entries."
    )
    parser.add_argument("root", nargs="?", type=Path, default=DEFAULT_ROOT)
    parser.add_argument("--keep", type=int, default=DEFAULT_KEEP)
    args = parser.parse_args(argv)
    prune_build_cache(args.root, args.keep)
    return 0


if __name__ == "__main__":
    sys.exit(main())
