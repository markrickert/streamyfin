#!/usr/bin/env python3
"""Whitelist tests for the temporary tvOS navigation trace collector."""
import importlib.util
import unittest
from pathlib import Path

MODULE = (
    Path(__file__).resolve().parent / "collect-tv-nav-trace.py"
)
spec = importlib.util.spec_from_file_location("collect_tv_nav_trace", MODULE)
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


def entry(timestamp: str, message: str) -> bytes:
    return (
        f'{{"timestamp":"{timestamp}","level":"DEBUG",'
        f'"message":"{message}"}}'
    ).encode("utf-8")


class ExtractTest(unittest.TestCase):
    def test_keeps_whitelisted_events_in_order_and_dedupes(self):
        blob = (
            entry("2025-01-01T00:00:00.000Z", "[DEBUG-TV-NAV] route=(libraries)|root")
            + b" noise "
            + entry("2025-01-01T00:00:01.000Z", "[DEBUG-TV-NAV] library-press")
            + b" more noise "
            + entry("2025-01-01T00:00:00.000Z", "[DEBUG-TV-NAV] route=(libraries)|root")
        )
        self.assertEqual(
            collector.extract(blob),
            [
                "2025-01-01T00:00:00.000Z route=(libraries)|root",
                "2025-01-01T00:00:01.000Z library-press",
            ],
        )

    def test_drops_credential_like_fields_and_unknown_events(self):
        blob = (
            b'{"username":"user@example.invalid","password":"hunter2"}'
            + entry(
                "2025-01-01T00:00:02.000Z",
                "[DEBUG-TV-NAV] route=https://example.invalid/x",
            )
            + entry(
                "2025-01-01T00:00:03.000Z",
                "[DEBUG-TV-NAV] token=abc123",
            )
            + entry(
                "2025-01-01T00:00:04.000Z",
                "[DEBUG-TV-NAV] detail-mounted",
            )
        )
        self.assertEqual(
            collector.extract(blob),
            ["2025-01-01T00:00:04.000Z detail-mounted"],
        )


if __name__ == "__main__":
    unittest.main()
