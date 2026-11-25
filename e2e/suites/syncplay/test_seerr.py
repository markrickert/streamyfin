"""Seerr onboarding and library enablement against the documented v3.5.0 API."""

import io
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest import mock
import urllib.error
import urllib.parse
import urllib.request

from suites.syncplay import seerr, setup

OWNED = {
    "SYNCPLAY_PROJECT": "streamyfin-syncplay-e2e",
    "SYNCPLAY_CONTAINER": "streamyfin-syncplay-e2e-jellyfin",
    "SYNCPLAY_PORT": "18096",
    "SYNCPLAY_SEERR_CONTAINER": "streamyfin-syncplay-e2e-seerr",
    "SYNCPLAY_SEERR_PORT": "15055",
    "SYNCPLAY_RADARR_CONTAINER": "streamyfin-syncplay-e2e-radarr",
    "SYNCPLAY_RADARR_PORT": "17878",
}


class Response(io.BytesIO):
    """BytesIO already has the context manager protocol opener.open callers need."""


class FakeOpener:
    """An opener.open double at the urllib boundary: serves queued routes, records every call."""

    def __init__(self):
        self.routes = {}
        self.calls = []

    def serve(self, method, path, *payloads):
        self.routes[(method, path)] = list(payloads)

    def open(self, request, timeout=None):
        method = request.get_method()
        path = urllib.parse.urlsplit(request.full_url).path
        body = json.loads(request.data.decode()) if request.data else None
        self.calls.append((method, path, body))
        queue = self.routes.get((method, path))
        if queue is None:
            raise AssertionError(f"unexpected {method} {path}")
        payload = queue[0] if len(queue) == 1 else queue.pop(0)
        if isinstance(payload, Exception):
            raise payload
        return Response(json.dumps(payload).encode())


def patched_opener(opener):
    return mock.patch.object(urllib.request, "build_opener", return_value=opener)


class EnsureReadyTest(unittest.TestCase):
    def test_first_run_onboards_syncs_enables_the_fixture_and_initializes(self):
        opener = FakeOpener()
        opener.serve("GET", "/api/v1/settings/public", {"initialized": False}, {"initialized": True})
        opener.serve("POST", "/api/v1/auth/jellyfin", {"id": 1})
        opener.serve("POST", "/api/v1/settings/jellyfin/library/sync", [
            {"id": "fx1", "name": "SyncPlay Fixtures", "enabled": False, "type": "movies"},
        ])
        opener.serve("PUT", "/api/v1/settings/jellyfin/library/fx1", {"id": "fx1", "enabled": True})
        opener.serve("POST", "/api/v1/settings/initialize", {"initialized": True})
        # A real developer .state/seerr/settings.json must not change what this sends.
        with TemporaryDirectory() as directory, mock.patch.object(setup, "STATE", Path(directory)), patched_opener(opener):
            seerr.ensure_ready(OWNED, username="syncplay-host", password="pw")
        self.assertEqual(opener.calls, [
            ("GET", "/api/v1/settings/public", None),
            ("POST", "/api/v1/auth/jellyfin", {
                "username": "syncplay-host", "password": "pw",
                "hostname": "jellyfin", "port": 8096, "useSsl": False, "urlBase": "",
                "email": "syncplay-host@localhost", "serverType": 2,
            }),
            ("POST", "/api/v1/settings/jellyfin/library/sync", None),
            ("PUT", "/api/v1/settings/jellyfin/library/fx1", {"enabled": True}),
            ("POST", "/api/v1/settings/initialize", None),
            ("GET", "/api/v1/settings/public", None),
        ])

    def test_retries_uninitialized_seerr_with_saved_jellyfin_without_hostname(self):
        # A first run that died before initialize leaves settings.jellyfin.ip saved; the
        # retry must not send a hostname — Seerr 500s on one once an ip is saved.
        opener = FakeOpener()
        opener.serve("GET", "/api/v1/settings/public", {"initialized": False}, {"initialized": True})
        opener.serve("POST", "/api/v1/auth/jellyfin", {"id": 1})
        opener.serve("POST", "/api/v1/settings/jellyfin/library/sync", [{"id": "fx1", "name": "SyncPlay Fixtures"}])
        opener.serve("PUT", "/api/v1/settings/jellyfin/library/fx1", {"id": "fx1", "enabled": True})
        opener.serve("POST", "/api/v1/settings/initialize", {"initialized": True})
        with TemporaryDirectory() as directory:
            state = Path(directory)
            (state / "seerr").mkdir()
            (state / "seerr" / "settings.json").write_text(json.dumps({"jellyfin": {"ip": "jellyfin"}}))
            with mock.patch.object(setup, "STATE", state), patched_opener(opener):
                seerr.ensure_ready(OWNED, username="syncplay-host", password="pw")
        self.assertEqual(
            opener.calls[1],
            ("POST", "/api/v1/auth/jellyfin", {"username": "syncplay-host", "password": "pw"}),
        )
        self.assertIn(("POST", "/api/v1/settings/jellyfin/library/sync", None), opener.calls)
        self.assertIn(("POST", "/api/v1/settings/initialize", None), opener.calls)

    def test_an_initialized_seerr_only_reuses_the_owner_login(self):
        opener = FakeOpener()
        opener.serve("GET", "/api/v1/settings/public", {"initialized": True})
        opener.serve("POST", "/api/v1/auth/jellyfin", {"id": 1})
        with patched_opener(opener):
            seerr.ensure_ready(OWNED, username="syncplay-host", password="pw")
        # A hostname here is a 500 once settings.jellyfin.ip is saved, so the rerun body omits it.
        self.assertEqual(opener.calls, [
            ("GET", "/api/v1/settings/public", None),
            ("POST", "/api/v1/auth/jellyfin", {"username": "syncplay-host", "password": "pw"}),
        ])

    def test_waits_for_seerr_to_answer_before_onboarding(self):
        opener = FakeOpener()
        opener.serve(
            "GET", "/api/v1/settings/public",
            urllib.error.URLError("connection refused"), {"initialized": True},
        )
        opener.serve("POST", "/api/v1/auth/jellyfin", {"id": 1})
        with patched_opener(opener), mock.patch.object(seerr.time, "sleep"):
            seerr.ensure_ready(OWNED, username="syncplay-host", password="pw")
        self.assertEqual(opener.calls[:2], [
            ("GET", "/api/v1/settings/public", None),
            ("GET", "/api/v1/settings/public", None),
        ])

    def test_a_seerr_that_never_answers_is_refused_after_the_bound(self):
        opener = FakeOpener()
        opener.serve("GET", "/api/v1/settings/public", urllib.error.URLError("connection refused"))
        with patched_opener(opener), mock.patch.object(seerr.time, "sleep"):
            with self.assertRaisesRegex(RuntimeError, "did not become ready"):
                seerr.ensure_ready(OWNED, username="syncplay-host", password="pw")
        self.assertEqual(len(opener.calls), seerr.READY_ATTEMPTS)


class EnsureRadarrTest(unittest.TestCase):
    SERVER = {"name": "Radarr", "hostname": "radarr", "port": 7878, "activeDirectory": "/radarr-media/movies-offline"}

    def test_adds_the_server_when_none_by_that_name_is_saved(self):
        opener = FakeOpener()
        opener.serve("POST", "/api/v1/auth/jellyfin", {"id": 1})
        opener.serve("GET", "/api/v1/settings/radarr", [{"id": 0, "name": "Other"}])
        opener.serve("POST", "/api/v1/settings/radarr", {"id": 1})
        with patched_opener(opener):
            seerr.ensure_radarr(OWNED, "syncplay-host", "pw", self.SERVER)
        self.assertEqual(opener.calls, [
            ("POST", "/api/v1/auth/jellyfin", {"username": "syncplay-host", "password": "pw"}),
            ("GET", "/api/v1/settings/radarr", None),
            ("POST", "/api/v1/settings/radarr", self.SERVER),
        ])

    def test_a_rerun_leaves_the_saved_server_alone(self):
        opener = FakeOpener()
        opener.serve("POST", "/api/v1/auth/jellyfin", {"id": 1})
        opener.serve("GET", "/api/v1/settings/radarr", [{"id": 0, "name": "Radarr"}])
        with patched_opener(opener):
            seerr.ensure_radarr(OWNED, "syncplay-host", "pw", self.SERVER)
        self.assertNotIn("POST", [method for method, path, _ in opener.calls if path == "/api/v1/settings/radarr"])


class EnableCatalogTest(unittest.TestCase):
    def test_syncs_and_enables_the_seed_libraries_by_id(self):
        opener = FakeOpener()
        opener.serve("GET", "/api/v1/settings/public", {"initialized": True})
        opener.serve("POST", "/api/v1/auth/jellyfin", {"id": 1})
        opener.serve("POST", "/api/v1/settings/jellyfin/library/sync", [
            {"id": "m1", "name": "Movies", "enabled": False, "type": "movies"},
            {"id": "s1", "name": "Shows", "enabled": False, "type": "tvshows"},
            {"id": "fx1", "name": "SyncPlay Fixtures", "enabled": True, "type": "movies"},
        ])
        for library_id in ("m1", "s1"):
            opener.serve("PUT", f"/api/v1/settings/jellyfin/library/{library_id}", {"id": library_id, "enabled": True})
        with patched_opener(opener):
            seerr.enable_catalog_libraries(OWNED)
        self.assertEqual(opener.calls, [
            ("GET", "/api/v1/settings/public", None),
            ("POST", "/api/v1/auth/jellyfin", {"username": "syncplay-host", "password": setup.PASSWORD}),
            ("POST", "/api/v1/settings/jellyfin/library/sync", None),
            ("PUT", "/api/v1/settings/jellyfin/library/m1", {"enabled": True}),
            ("PUT", "/api/v1/settings/jellyfin/library/s1", {"enabled": True}),
        ])

    def test_a_missing_seed_library_aborts_before_any_enable(self):
        opener = FakeOpener()
        opener.serve("GET", "/api/v1/settings/public", {"initialized": True})
        opener.serve("POST", "/api/v1/auth/jellyfin", {"id": 1})
        opener.serve("POST", "/api/v1/settings/jellyfin/library/sync", [
            {"id": "m1", "name": "Movies", "enabled": False, "type": "movies"},
        ])
        with patched_opener(opener):
            with self.assertRaisesRegex(RuntimeError, "Shows"):
                seerr.enable_catalog_libraries(OWNED)
        self.assertFalse([call for call in opener.calls if call[0] == "PUT"])

    def test_a_synced_music_library_is_never_enabled(self):
        # Seerr's mapLibraries excludes music folders, so Music is not a catalog member
        # even when Jellyfin somehow surfaces it in the sync response.
        opener = FakeOpener()
        opener.serve("GET", "/api/v1/settings/public", {"initialized": True})
        opener.serve("POST", "/api/v1/auth/jellyfin", {"id": 1})
        opener.serve("POST", "/api/v1/settings/jellyfin/library/sync", [
            {"id": "m1", "name": "Movies", "enabled": False, "type": "movies"},
            {"id": "s1", "name": "Shows", "enabled": False, "type": "tvshows"},
            {"id": "mu1", "name": "Music", "enabled": False, "type": "music"},
        ])
        for library_id in ("m1", "s1"):
            opener.serve("PUT", f"/api/v1/settings/jellyfin/library/{library_id}", {"id": library_id, "enabled": True})
        with patched_opener(opener):
            seerr.enable_catalog_libraries(OWNED)
        self.assertEqual(
            [call for call in opener.calls if call[0] == "PUT"],
            [
                ("PUT", "/api/v1/settings/jellyfin/library/m1", {"enabled": True}),
                ("PUT", "/api/v1/settings/jellyfin/library/s1", {"enabled": True}),
            ],
        )
class ProvisionClientAccessTest(unittest.TestCase):
    """Pushes the fixture Seerr into the plugin config so TV builds connect at sign-in."""

    def state(self, root):
        (root / "credentials.json").write_text(json.dumps({"host": {"token": "tok"}}))
        (root / "seerr").mkdir()
        (root / "seerr" / "settings.json").write_text(json.dumps({"main": {"apiKey": "key-123"}}))

    def test_sets_url_and_api_key_preserving_other_entries(self):
        import tempfile
        from pathlib import Path

        calls = []
        config = {"settings": {
            "jellyseerrServerUrl": {"locked": False, "value": "Enter jellyseerr server url"},
            "home": {"locked": False, "value": {"sections": []}},
        }}

        def api(path, method="GET", data=None, token=None):
            calls.append((method, path, data, token))
            return config if path == "/Streamyfin/config" else None

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.state(root)
            with mock.patch.object(setup, "STATE", root), mock.patch.object(setup, "api", api):
                seerr.provision_client_access(OWNED)

        self.assertEqual(calls[0], ("GET", "/Streamyfin/config", None, "tok"))
        method, path, body, token = calls[1]
        self.assertEqual((method, path, token), ("POST", "/streamyfin/config/yaml", "tok"))
        posted = json.loads(body["value"])
        self.assertEqual(posted["settings"]["jellyseerrServerUrl"], {"locked": False, "value": "http://127.0.0.1:15055"})
        self.assertEqual(posted["settings"]["jellyseerrApiKey"], {"value": "key-123"})
        self.assertEqual(posted["settings"]["home"], {"locked": False, "value": {"sections": []}})

    def test_missing_api_key_refuses(self):
        import tempfile
        from pathlib import Path

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "credentials.json").write_text(json.dumps({"host": {"token": "tok"}}))
            (root / "seerr").mkdir()
            (root / "seerr" / "settings.json").write_text(json.dumps({"main": {"apiKey": ""}}))
            with mock.patch.object(setup, "STATE", root), self.assertRaisesRegex(RuntimeError, "apiKey"):
                seerr.provision_client_access(OWNED)


if __name__ == "__main__":
    unittest.main()
