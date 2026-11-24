#!/usr/bin/env python3
"""Create a fresh iOS or Apple TV simulator on the newest available runtime."""

import argparse
import json
import subprocess
import sys

SPECS = {
    "ios": {
        "runtime_platform": "iOS",
        "runtime_prefix": "com.apple.CoreSimulator.SimRuntime.iOS-",
        "preferred_models": ("iPhone 16", "iPhone 17", "iPhone 15"),
        "fallback_substring": "iPhone",
        "simulator_name": "e2e-screenshots-ios",
    },
    "apple-tv": {
        "runtime_platform": "tvOS",
        "runtime_prefix": "com.apple.CoreSimulator.SimRuntime.tvOS-",
        "preferred_models": ("Apple TV 4K (3rd generation)",),
        "fallback_substring": "Apple TV",
        "simulator_name": "e2e-screenshots-apple-tv",
    },
}


def version_key(version: str) -> tuple[int, ...]:
    parts = []
    for part in version.split("."):
        digits = "".join(ch for ch in part if ch.isdigit())
        parts.append(int(digits) if digits else 0)
    return tuple(parts)


def select_runtime_and_device_type(data: dict, platform: str) -> tuple[str, str]:
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
    by_name = {d["name"]: d["identifier"] for d in supported}
    device_type = next(
        (by_name[name] for name in spec["preferred_models"] if name in by_name),
        None,
    )
    if not device_type:
        matches = [
            d for d in supported if spec["fallback_substring"] in d.get("name", "")
        ]
        if not matches:
            raise SystemExit(
                f"No {spec['fallback_substring']} device type available for {runtime['identifier']}"
            )
        device_type = matches[0]["identifier"]

    return runtime["identifier"], device_type


def create_simulator(platform: str) -> str:
    data = json.loads(
        subprocess.check_output(["xcrun", "simctl", "list", "-j"], text=True)
    )
    runtime_id, device_type = select_runtime_and_device_type(data, platform)
    sim_name = SPECS[platform]["simulator_name"]
    return subprocess.check_output(
        ["xcrun", "simctl", "create", sim_name, device_type, runtime_id],
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
