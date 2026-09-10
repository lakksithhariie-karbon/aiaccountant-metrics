from datetime import date

import httpx
import pytest

from fetcher.export_client import (
    ExportAuthError,
    ExportClient,
    ExportRateLimitError,
    needs_split,
)


def test_needs_split_at_one_hundred_thousand_lines():
    jsonl = "\n".join(["{}"] * 100_000)
    assert needs_split(jsonl) is True
    assert needs_split("{}\n{}") is False


def test_export_day_returns_jsonl_on_200():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.host == "data.mixpanel.com"
        assert request.url.path == "/api/2.0/export"
        assert request.url.params["project_id"] == "3490984"
        assert request.url.params["from_date"] == "2026-09-03"
        assert request.url.params["to_date"] == "2026-09-03"
        assert request.url.params["time_in_ms"] == "true"
        assert request.headers["accept-encoding"] == "gzip"
        return httpx.Response(200, text='{"event":"Login","properties":{}}\n')

    client = ExportClient(
        project_id=3490984,
        username="sa",
        secret="secret",
        http=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    body = client.export_day(date(2026, 9, 3))
    assert "Login" in body


def test_export_day_passes_where_clause():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["where"] = request.url.params.get("where")
        return httpx.Response(200, text="")

    client = ExportClient(
        project_id=3490984,
        username="sa",
        secret="secret",
        http=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    where = 'properties["time"]>=1756857600 and properties["time"]<1756879200'
    client.export_day(date(2026, 9, 3), event_names=["Login"], where=where)
    assert seen["where"] == where


def test_export_day_passes_event_filter():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["event"] = request.url.params.get("event")
        return httpx.Response(200, text="")

    client = ExportClient(
        project_id=3490984,
        username="sa",
        secret="secret",
        http=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    client.export_day(date(2026, 9, 3), event_names=["Sign Up", "Upload"])
    assert seen["event"] == '["Sign Up", "Upload"]' or "Sign Up" in seen["event"]


def test_401_raises_auth_error_without_retry():
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(401, text="nope")

    client = ExportClient(
        project_id=3490984,
        username="sa",
        secret="secret",
        http=httpx.Client(transport=httpx.MockTransport(handler)),
        sleep=lambda _seconds: None,
    )
    with pytest.raises(ExportAuthError):
        client.export_day(date(2026, 9, 3))
    assert calls["n"] == 1


def test_403_raises_auth_error():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(403, text="forbidden")

    client = ExportClient(
        project_id=3490984,
        username="sa",
        secret="secret",
        http=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    with pytest.raises(ExportAuthError):
        client.export_day(date(2026, 9, 3))


def test_429_retries_then_succeeds():
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(429, text="slow")
        return httpx.Response(200, text='{"event":"Login","properties":{}}\n')

    client = ExportClient(
        project_id=3490984,
        username="sa",
        secret="secret",
        http=httpx.Client(transport=httpx.MockTransport(handler)),
        sleep=lambda _seconds: None,
        max_retries=3,
    )
    body = client.export_day(date(2026, 9, 3))
    assert "Login" in body
    assert calls["n"] == 2


def test_429_exhausted_raises_rate_limit():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, text="slow")

    client = ExportClient(
        project_id=3490984,
        username="sa",
        secret="secret",
        http=httpx.Client(transport=httpx.MockTransport(handler)),
        sleep=lambda _seconds: None,
        max_retries=2,
    )
    with pytest.raises(ExportRateLimitError):
        client.export_day(date(2026, 9, 3))
