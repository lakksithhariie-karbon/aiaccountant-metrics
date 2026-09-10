from __future__ import annotations

import json
import time
from collections.abc import Callable
from datetime import date

import httpx

EXPORT_URL = "https://data.mixpanel.com/api/2.0/export"
MAX_EVENTS_PER_REQUEST = 100_000


class ExportAuthError(Exception):
    pass


class ExportRateLimitError(Exception):
    pass


class ExportHttpError(Exception):
    pass


def needs_split(jsonl: str) -> bool:
    if not jsonl.strip():
        return False
    lines = [line for line in jsonl.splitlines() if line.strip()]
    return len(lines) >= MAX_EVENTS_PER_REQUEST


class ExportClient:
    def __init__(
        self,
        project_id: int,
        username: str,
        secret: str,
        http: httpx.Client | None = None,
        sleep: Callable[[float], None] | None = None,
        max_retries: int = 5,
    ) -> None:
        self.project_id = project_id
        self.username = username
        self.secret = secret
        self.http = http or httpx.Client(timeout=120.0)
        self._sleep = sleep or time.sleep
        self.max_retries = max_retries
        self.request_count = 0
        self.rate_limit_hits = 0

    def export_day(
        self,
        day: date,
        event_names: list[str] | None = None,
        where: str | None = None,
    ) -> str:
        params: dict[str, str] = {
            "project_id": str(self.project_id),
            "from_date": day.isoformat(),
            "to_date": day.isoformat(),
            "time_in_ms": "true",
        }
        if event_names:
            params["event"] = json.dumps(event_names)
        if where:
            params["where"] = where
        last_429: httpx.Response | None = None
        for attempt in range(self.max_retries):
            self.request_count += 1
            response = self.http.get(
                EXPORT_URL,
                params=params,
                auth=(self.username, self.secret),
                headers={"Accept-Encoding": "gzip"},
            )
            if response.status_code in (401, 403):
                raise ExportAuthError(
                    f"Mixpanel export auth failed ({response.status_code}). "
                    "Need a service account that can export events."
                )
            if response.status_code == 429:
                self.rate_limit_hits += 1
                last_429 = response
                self._sleep(min(60.0, 2 ** attempt))
                continue
            if response.status_code >= 400:
                raise ExportHttpError(
                    f"Mixpanel export failed ({response.status_code})"
                )
            return response.text
        raise ExportRateLimitError(
            f"Mixpanel export rate limited after {self.max_retries} attempts"
            + (f": {last_429.text[:200]}" if last_429 is not None else "")
        )
