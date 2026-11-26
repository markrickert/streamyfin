#!/usr/bin/env python3
"""Create a fresh iOS or Apple TV simulator on the newest available runtime."""

import argparse
import json
import re
import subprocess
import sys

BASE_IPHONE = re.compile(r"^iPhone (\d+)$")


def highest_base_iphone(supported: list[dict], _needle: str) -> dict | None:
    """The newest plain `iPhone N`; Pro/Max/SE/Fold variants change the screen size,
    so they are never a safe screenshot fallback."""
    numbered = [
        (int(match.group(1)), device)
        for device in supported
        if (match := BASE_IPHONE.fullmatch(device.get("name", "")))
    ]
    return max(numbered)[1] if numbered else None


def first_name_match(supported: list[dict], needle: str) -> dict | None:
    return next((d for d in supported if needle in d.get("name", "")), None)


SPECS = {
    "ios": {
        "runtime_platform": "iOS",
        "runtime_prefix": "com.apple.CoreSimulator.SimRuntime.iOS-",
        "preferred_models": ("iPhone 16", "iPhone 17", "iPhone 15"),
        "name_needle": "iPhone",
        "fallback": highest_base_iphone,
        "simulator_name": "e2e-screenshots-ios",
    },
    "apple-tv": {
        "runtime_platform": "tvOS",
        "runtime_prefix": "com.apple.CoreSimulator.SimRuntime.tvOS-",
        "preferred_models": ("Apple TV 4K (3rd generation)",),
        "name_needle": "Apple TV",
        "fallback": first_name_match,
        "simulator_name": "e2e-screenshots-apple-tv",
    },
}


def version_key(version: str) -> tuple[int, ...]:
    parts = []
    for part in version.split("."):
        digits = "".join(ch for ch in part if ch.isdigit())
        parts.append(int(digits) if digits else 0)
    return tuple(parts)


def select_runtime_and_device_type(data: dict, platform: str) -> tuple[str, dict]:
    spec = SPECS[platform]
    runtimes = [
        r
        for r in data.get("runtimes", [])
        if r.get("isAvailable")
        and (
            r.get("platform") == spec["runtime_platform"]
            or r.get("identifier", "").startswith(spec["runtime_prefix"])
        )
    ]
    if not runtimes:
        raise SystemExit(
            f"No available {spec['runtime_platform']} simulator runtime found"
        )
    runtimes.sort(key=lambda r: version_key(r["version"]), reverse=True)
    runtime = runtimes[0]

    supported = runtime.get("supportedDeviceTypes") or data.get("devicetypes", [])
    by_name = {d["name"]: d for d in supported}
    device_type = next(
        (by_name[name] for name in spec["preferred_models"] if name in by_name),
        None,
    )
    if device_type is None:
        device_type = spec["fallback"](supported, spec["name_needle"])
    if device_type is None:
        names = ", ".join(
            d["name"]
            for d in supported
            if spec["name_needle"] in d.get("name", "")
        )
        raise SystemExit(
            f"No {spec['name_needle']} device type available for {runtime['identifier']} ({names or 'none'})"
        )

    return runtime["identifier"], device_type


def create_simulator(platform: str) -> str:
    data = json.loads(
        subprocess.check_output(["xcrun", "simctl", "list", "-j"], text=True)
    )
    runtime_id, device_type = select_runtime_and_device_type(data, platform)
    # stdout stays the UDID alone for the workflow's capture; the choice goes to stderr.
    print(
        f"create-simulator: {device_type['name']} ({device_type['identifier']}) on {runtime_id}",
        file=sys.stderr,
    )
    sim_name = SPECS[platform]["simulator_name"]
    return subprocess.check_output(
        ["xcrun", "simctl", "create", sim_name, device_type["identifier"], runtime_id],
        text=True,
    ).strip()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Create an iOS or Apple TV simulator."
    )
    parser.add_argument("platform", choices=tuple(SPECS))
    args = parser.parse_args(argv)
    print(create_simulator(args.platform))
    return 0


if __name__ == "__main__":
    sys.exit(main())
