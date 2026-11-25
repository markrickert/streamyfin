#!/usr/bin/env python3
"""Export only temporary tvOS navigation markers from the simulator's MMKV log."""
import re
import sys
from pathlib import Path

EVENT = rb"(?:route=(?:\(home\)|\(search\)|\(libraries\)|\(tv-favorites\)|\(tv-settings\)|\(tv-watchlists\)|none)\|(?:tabs|root|library-detail|other)|redirect-tabs-root|home-tab-press|library-press|detail-mounted|detail-unmounted)"
ENTRY = re.compile(rb'\{"timestamp":"([0-9TZ:.\-]{10,35})","level":"DEBUG","message":"\[DEBUG-TV-NAV\] (' + EVENT + rb')"\}')

def extract(blob: bytes) -> list[str]:
    seen: set[tuple[bytes, bytes]] = set()
    lines: list[str] = []
    for match in ENTRY.finditer(blob):
        entry = (match.group(1), match.group(2))
        if entry in seen:
            continue
        seen.add(entry)
        lines.append(f"{entry[0].decode('ascii')} {entry[1].decode('ascii')}")
    return lines

def main() -> None:
    source, target = map(Path, sys.argv[1:3])
    lines = extract(source.read_bytes())
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"tvOS navigation markers: {len(lines)}")

if __name__ == "__main__":
    main()
